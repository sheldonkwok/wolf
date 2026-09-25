use std::collections::{BTreeMap, BTreeSet};

use crate::rng::{SplitMix64, time_seed};

mod error;
mod player;
#[cfg(test)]
mod tests;

pub use error::GameError;
pub use player::{Player, PlayerId, Role};

/// Which half of the game loop we are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Living night roles act; resolved with [`Engine::resolve_night`].
    Night,
    /// Players discuss and vote until a strict majority agrees; resolved with [`Engine::resolve_day`].
    Day,
    /// A team has won. No further commands are accepted.
    Ended,
    /// An eliminated hunter takes their final shot before play resumes.
    Hunter,
}

/// The winning team once the game is over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    Villagers,
    Werewolves,
}

/// The result of resolving a night.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NightOutcome {
    /// The werewolves' target was eliminated.
    Killed(PlayerId),
    /// The doctor protected the werewolves' target.
    Saved(PlayerId),
    /// The pack named more than one target; nobody died and they pick again.
    NoConsensus { targets: Vec<PlayerId> },
}

/// A private seer result, retained for moderator inspection and reconnecting players.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inspection {
    pub seer: PlayerId,
    pub target: PlayerId,
    pub round: usize,
    pub is_werewolf: bool,
}

/// The result of resolving a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayOutcome {
    /// The player with a strict majority of living players was eliminated.
    Eliminated(PlayerId),
}

/// The game engine and moderator: owns all state, built with [`Engine::new`] or [`Engine::with_roles`] and driven by the night/day commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    players: Vec<Player>,
    phase: Phase,
    round: usize,
    winner: Option<Winner>,
    /// Living werewolf -> the player they named this night.
    night_picks: BTreeMap<PlayerId, PlayerId>,
    doctor_picks: BTreeMap<PlayerId, PlayerId>,
    seer_picks: BTreeMap<PlayerId, PlayerId>,
    inspections: Vec<Inspection>,
    /// Living voter -> the player they voted for this day.
    day_votes: BTreeMap<PlayerId, PlayerId>,
    pending_hunter: Option<(PlayerId, Phase)>,
}

impl Engine {
    /// The fewest players a game can be built with.
    pub const MIN_PLAYERS: usize = 5;

    /// Build a game for `player_count` players with random roles: one doctor, one seer, one hunter, `max(1, player_count / 4)` wolves, and villagers.
    pub fn new(player_count: usize) -> Result<Self, GameError> {
        Self::with_seed(player_count, time_seed())
    }

    /// Like [`Engine::new`], but the deal is drawn from `seed` so a game can be reproduced.
    pub fn with_seed(player_count: usize, seed: u64) -> Result<Self, GameError> {
        if player_count < Self::MIN_PLAYERS {
            return Err(GameError::TooFewPlayers {
                got: player_count,
                min: Self::MIN_PLAYERS,
            });
        }

        let wolves = (player_count / 4).max(1);
        let mut roles = Vec::with_capacity(player_count);
        roles.extend(std::iter::repeat_n(Role::Werewolf, wolves));
        roles.extend([Role::Doctor, Role::Seer, Role::Hunter]);
        roles.extend(std::iter::repeat_n(
            Role::Villager,
            player_count - wolves - 3,
        ));
        SplitMix64::new(seed).shuffle(&mut roles);

        Ok(Self::from_roles(&roles))
    }

    /// Build a game from an exact role list (`roles[i]` is `Pi`), rejecting rosters the game could never begin from; this is the deterministic constructor tests use.
    pub fn with_roles(roles: &[Role]) -> Result<Self, GameError> {
        if roles.len() < Self::MIN_PLAYERS {
            return Err(GameError::TooFewPlayers {
                got: roles.len(),
                min: Self::MIN_PLAYERS,
            });
        }
        let wolves = roles.iter().filter(|r| **r == Role::Werewolf).count();
        let villagers = roles.len() - wolves;
        if wolves == 0 {
            return Err(GameError::InvalidRoster("roster has no werewolves"));
        }
        if wolves >= villagers {
            return Err(GameError::InvalidRoster(
                "werewolves start at or above parity with villagers",
            ));
        }
        for role in [Role::Doctor, Role::Seer, Role::Hunter] {
            if roles.iter().filter(|r| **r == role).count() > 1 {
                return Err(GameError::InvalidRoster(
                    "at most one doctor, one seer, and one hunter are allowed",
                ));
            }
        }
        Ok(Self::from_roles(roles))
    }

    fn from_roles(roles: &[Role]) -> Self {
        let players = roles
            .iter()
            .enumerate()
            .map(|(i, &role)| Player::new(PlayerId(i), role))
            .collect();
        Engine {
            players,
            phase: Phase::Day,
            round: 1,
            winner: None,
            night_picks: BTreeMap::new(),
            doctor_picks: BTreeMap::new(),
            seer_picks: BTreeMap::new(),
            inspections: Vec::new(),
            day_votes: BTreeMap::new(),
            pending_hunter: None,
        }
    }

    // ----- commands -------------------------------------------------------

    /// Record one werewolf naming `target` for tonight's kill; a wolf may overwrite their pick freely until the night resolves.
    pub fn night_action(&mut self, wolf: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Night)?;

        let actor = self.require_alive(wolf)?;
        if actor.role() != Role::Werewolf {
            return Err(GameError::NotAWerewolf(wolf));
        }
        self.require_alive(target)?;

        if wolf == target && self.alive_count_by_role().1 == 1 {
            return Err(GameError::LastWolfCannotTargetSelf);
        }

        self.night_picks.insert(wolf, target);
        Ok(())
    }

    /// Protect one living player, including the doctor themselves; the choice is final for this night.
    pub fn doctor_action(&mut self, doctor: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Night)?;
        if self.require_alive(doctor)?.role() != Role::Doctor {
            return Err(GameError::NotADoctor(doctor));
        }
        self.require_alive(target)?;
        if self.doctor_picks.contains_key(&doctor) {
            return Err(GameError::AlreadyActed(doctor));
        }
        self.doctor_picks.insert(doctor, target);
        Ok(())
    }

    /// Inspect one living player once per night; reveals only werewolf versus innocent.
    pub fn seer_action(
        &mut self,
        seer: PlayerId,
        target: PlayerId,
    ) -> Result<Inspection, GameError> {
        self.ensure_phase(Phase::Night)?;
        if self.require_alive(seer)?.role() != Role::Seer {
            return Err(GameError::NotASeer(seer));
        }
        let is_werewolf = self.require_alive(target)?.role() == Role::Werewolf;
        if self.seer_picks.contains_key(&seer) {
            return Err(GameError::AlreadyActed(seer));
        }
        let inspection = Inspection {
            seer,
            target,
            round: self.round,
            is_werewolf,
        };
        self.seer_picks.insert(seer, target);
        self.inspections.push(inspection);
        Ok(inspection)
    }

    /// Resolve the night: eliminate the wolves' agreed target, check for a win, advance to [`Phase::Day`] or [`Phase::Ended`].
    pub fn resolve_night(&mut self) -> Result<NightOutcome, GameError> {
        self.ensure_phase(Phase::Night)?;

        let living_wolves = self.living_ids_where(|p| p.role() == Role::Werewolf);
        let waiting_on = self.pending_actors();
        if !waiting_on.is_empty() {
            return Err(GameError::ActionsIncomplete { waiting_on });
        }

        let targets: BTreeSet<PlayerId> = living_wolves
            .iter()
            .map(|id| self.night_picks[id])
            .collect();
        if targets.len() != 1 {
            // A split pack is not an error: wipe the board and let them pick again.
            self.night_picks.clear();
            return Ok(NightOutcome::NoConsensus {
                targets: targets.into_iter().collect(),
            });
        }
        let target = targets.into_iter().next().expect("exactly one target");

        let saved = self.doctor_picks.values().any(|&pick| pick == target);
        self.night_picks.clear();
        self.doctor_picks.clear();
        self.seer_picks.clear();
        if saved {
            self.resume(Phase::Day);
        } else {
            self.eliminate(target, Phase::Day);
        }
        Ok(if saved {
            NightOutcome::Saved(target)
        } else {
            NightOutcome::Killed(target)
        })
    }

    /// Record or replace a living player's day vote for a living target.
    pub fn vote(&mut self, voter: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Day)?;
        self.require_alive(voter)?;
        self.require_alive(target)?;
        self.day_votes.insert(voter, target);
        Ok(())
    }

    /// Eliminate the strict majority target and advance to night, or leave the day unchanged without a majority.
    pub fn resolve_day(&mut self) -> Result<DayOutcome, GameError> {
        self.ensure_phase(Phase::Day)?;
        let target = self.majority_target().ok_or(GameError::NoMajority)?;
        self.day_votes.clear();
        self.eliminate(target, Phase::Night);
        Ok(DayOutcome::Eliminated(target))
    }

    /// The eliminated hunter must shoot one living player before victory is checked.
    pub fn hunter_action(&mut self, hunter: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Hunter)?;
        self.role_of(hunter)?;
        let (pending, next) = self.pending_hunter.expect("hunter phase has an actor");
        if hunter != pending {
            return Err(GameError::NotPendingHunter(hunter));
        }
        self.require_alive(target)?;
        self.players[target.index()].kill();
        self.pending_hunter = None;
        self.resume(next);
        Ok(())
    }

    // ----- inspection ---------------------------------------------------------

    /// Convenience wrapper: `engine.player(3)` is `PlayerId(3)`, validated only when used.
    pub fn player(&self, index: usize) -> PlayerId {
        PlayerId(index)
    }

    /// The current phase.
    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// The current round number, starting at 1 and bumped when a night resolves into a day.
    pub fn round(&self) -> usize {
        self.round
    }

    /// The winning team, or `None` while the game is still going.
    pub fn winner(&self) -> Option<Winner> {
        self.winner
    }

    /// Whether the game has ended.
    pub fn is_over(&self) -> bool {
        self.phase == Phase::Ended
    }

    /// Every player, in id order.
    pub fn players(&self) -> &[Player] {
        &self.players
    }

    /// The living players, in id order.
    pub fn alive(&self) -> impl Iterator<Item = &Player> {
        self.players.iter().filter(|p| p.is_alive())
    }

    /// Whether `id` refers to a living player. `false` for unknown ids.
    pub fn is_alive(&self, id: PlayerId) -> bool {
        self.players.get(id.index()).is_some_and(|p| p.is_alive())
    }

    /// The role of `id`; the engine is the moderator, so keeping roles secret is the chat adapter's job.
    pub fn role_of(&self, id: PlayerId) -> Result<Role, GameError> {
        self.players
            .get(id.index())
            .map(|p| p.role())
            .ok_or(GameError::UnknownPlayer(id))
    }

    /// `(living village team including doctor and seer, living werewolves)`.
    pub fn alive_count_by_role(&self) -> (usize, usize) {
        let mut villagers = 0;
        let mut wolves = 0;
        for p in self.alive() {
            match p.role() {
                Role::Villager | Role::Doctor | Role::Seer | Role::Hunter => villagers += 1,
                Role::Werewolf => wolves += 1,
            }
        }
        (villagers, wolves)
    }

    /// Pending night roles at night, non-voters during the day, or nobody after ending.
    pub fn pending_actors(&self) -> Vec<PlayerId> {
        match self.phase {
            Phase::Night => self
                .living_ids_where(|p| match p.role() {
                    Role::Werewolf => !self.night_picks.contains_key(&p.id()),
                    Role::Doctor => !self.doctor_picks.contains_key(&p.id()),
                    Role::Seer => !self.seer_picks.contains_key(&p.id()),
                    Role::Villager | Role::Hunter => false,
                })
                .into_iter()
                .collect(),
            Phase::Day => self
                .living_ids_where(|_| true)
                .into_iter()
                .filter(|id| !self.day_votes.contains_key(id))
                .collect(),
            Phase::Hunter => vec![self.pending_hunter.expect("hunter phase has an actor").0],
            Phase::Ended => Vec::new(),
        }
    }

    /// Votes needed to eliminate a player: strictly more than half the living players.
    pub fn majority_required(&self) -> usize {
        self.alive().count() / 2 + 1
    }

    /// The target with a strict majority, if any; adapters can resolve immediately without waiting for all voters.
    pub fn majority_target(&self) -> Option<PlayerId> {
        let mut tally = BTreeMap::new();
        for &target in self.day_votes.values() {
            let count = tally.entry(target).or_insert(0);
            *count += 1;
            if *count >= self.majority_required() {
                return Some(target);
            }
        }
        None
    }

    /// Votes cast so far this day as `voter -> target`; empty outside the day phase.
    pub fn current_votes(&self) -> BTreeMap<PlayerId, PlayerId> {
        if self.phase == Phase::Day {
            self.day_votes.clone()
        } else {
            BTreeMap::new()
        }
    }

    /// The pack's picks so far this night as `wolf -> target`; empty outside the night phase.
    pub fn current_night_picks(&self) -> BTreeMap<PlayerId, PlayerId> {
        if self.phase == Phase::Night {
            self.night_picks.clone()
        } else {
            BTreeMap::new()
        }
    }

    /// The doctor's current protection choice; empty outside the night phase.
    pub fn current_doctor_picks(&self) -> BTreeMap<PlayerId, PlayerId> {
        self.doctor_picks.clone()
    }

    /// All private seer results; adapters must only disclose each result to its seer.
    pub fn inspections(&self) -> &[Inspection] {
        &self.inspections
    }

    // ----- internals --------------------------------------------------------

    fn eliminate(&mut self, target: PlayerId, next: Phase) {
        self.players[target.index()].kill();
        if self.players[target.index()].role() == Role::Hunter {
            self.pending_hunter = Some((target, next));
            self.phase = Phase::Hunter;
        } else {
            self.resume(next);
        }
    }

    fn resume(&mut self, next: Phase) {
        self.settle();
        if self.phase != Phase::Ended {
            self.phase = next;
            if next == Phase::Day {
                self.round += 1;
            }
        }
    }

    fn ensure_phase(&self, expected: Phase) -> Result<(), GameError> {
        if self.phase == Phase::Ended {
            return Err(GameError::GameOver);
        }
        if self.phase != expected {
            return Err(GameError::WrongPhase {
                expected,
                actual: self.phase,
            });
        }
        Ok(())
    }

    fn require_alive(&self, id: PlayerId) -> Result<&Player, GameError> {
        let player = self
            .players
            .get(id.index())
            .ok_or(GameError::UnknownPlayer(id))?;
        if player.is_alive() {
            Ok(player)
        } else {
            Err(GameError::PlayerNotAlive(id))
        }
    }

    fn living_ids_where(&self, pred: impl Fn(&Player) -> bool) -> Vec<PlayerId> {
        self.players
            .iter()
            .filter(|p| p.is_alive() && pred(p))
            .map(|p| p.id())
            .collect()
    }

    /// Decide the game if a win condition is now met; the no-wolves check comes first so a final lynch wins.
    fn settle(&mut self) {
        let (villagers, wolves) = self.alive_count_by_role();
        let result = if wolves == 0 {
            Some(Winner::Villagers)
        } else if wolves >= villagers {
            Some(Winner::Werewolves)
        } else {
            None
        };
        if let Some(winner) = result {
            self.winner = Some(winner);
            self.phase = Phase::Ended;
        }
    }
}
