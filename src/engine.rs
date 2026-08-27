use std::collections::{BTreeMap, BTreeSet};

use crate::error::GameError;
use crate::player::{Player, PlayerId, Role};
use crate::rng::{SplitMix64, time_seed};

/// Which half of the game loop we are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Werewolves choose a victim; resolved with [`Engine::resolve_night`].
    Night,
    /// Everyone votes; resolved with [`Engine::resolve_day`].
    Day,
    /// A team has won. No further commands are accepted.
    Ended,
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
    /// The pack named more than one target; nobody died and they pick again.
    NoConsensus { targets: Vec<PlayerId> },
}

/// The result of resolving a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayOutcome {
    /// The player with the most votes was eliminated.
    Eliminated(PlayerId),
    /// The vote was tied for the lead; nobody was eliminated.
    NoElimination,
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
    /// Living voter -> the player they voted for this day.
    day_votes: BTreeMap<PlayerId, PlayerId>,
}

impl Engine {
    /// The fewest players a game can be built with.
    pub const MIN_PLAYERS: usize = 5;

    /// Build a game for `player_count` players with random roles; wolves are `max(1, player_count / 4)`.
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
        roles.extend(std::iter::repeat_n(Role::Villager, player_count - wolves));
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
            phase: Phase::Night,
            round: 1,
            winner: None,
            night_picks: BTreeMap::new(),
            day_votes: BTreeMap::new(),
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

        self.night_picks.insert(wolf, target);
        Ok(())
    }

    /// Resolve the night: eliminate the wolves' agreed target, check for a win, advance to [`Phase::Day`] or [`Phase::Ended`].
    pub fn resolve_night(&mut self) -> Result<NightOutcome, GameError> {
        self.ensure_phase(Phase::Night)?;

        let living_wolves = self.living_ids_where(|p| p.role() == Role::Werewolf);
        let waiting_on: Vec<PlayerId> = living_wolves
            .iter()
            .copied()
            .filter(|id| !self.night_picks.contains_key(id))
            .collect();
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

        self.night_picks.clear();
        self.players[target.index()].kill();
        self.settle();
        if self.phase != Phase::Ended {
            self.phase = Phase::Day;
        }
        Ok(NightOutcome::Killed(target))
    }

    /// Record `voter`'s day vote for `target`; one final vote per living player.
    pub fn vote(&mut self, voter: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Day)?;

        self.require_alive(voter)?;
        self.require_alive(target)?;
        if self.day_votes.contains_key(&voter) {
            return Err(GameError::AlreadyActed(voter));
        }

        self.day_votes.insert(voter, target);
        Ok(())
    }

    /// Resolve the day: eliminate the vote leader (a tie for the lead eliminates nobody), check for a win, advance to the next [`Phase::Night`] or [`Phase::Ended`].
    pub fn resolve_day(&mut self) -> Result<DayOutcome, GameError> {
        self.ensure_phase(Phase::Day)?;

        let living = self.living_ids_where(|_| true);
        let waiting_on: Vec<PlayerId> = living
            .iter()
            .copied()
            .filter(|id| !self.day_votes.contains_key(id))
            .collect();
        if !waiting_on.is_empty() {
            return Err(GameError::ActionsIncomplete { waiting_on });
        }

        let mut tally: BTreeMap<PlayerId, usize> = BTreeMap::new();
        for target in self.day_votes.values() {
            *tally.entry(*target).or_default() += 1;
        }
        let top = tally.values().copied().max().expect("at least one vote");
        let leaders: Vec<PlayerId> = tally
            .iter()
            .filter(|(_, count)| **count == top)
            .map(|(id, _)| *id)
            .collect();

        self.day_votes.clear();

        if leaders.len() != 1 {
            self.phase = Phase::Night;
            self.round += 1;
            return Ok(DayOutcome::NoElimination);
        }

        let target = leaders[0];
        self.players[target.index()].kill();
        self.settle();
        if self.phase != Phase::Ended {
            self.phase = Phase::Night;
            self.round += 1;
        }
        Ok(DayOutcome::Eliminated(target))
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

    /// The current round number, starting at 1 and bumped when a day resolves into a night.
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

    /// `(living villagers, living werewolves)`.
    pub fn alive_count_by_role(&self) -> (usize, usize) {
        let mut villagers = 0;
        let mut wolves = 0;
        for p in self.alive() {
            match p.role() {
                Role::Villager => villagers += 1,
                Role::Werewolf => wolves += 1,
            }
        }
        (villagers, wolves)
    }

    /// Who the engine still waits on and a chat bot nudges: unacted wolves (Night), non-voters (Day), or nobody (Ended).
    pub fn pending_actors(&self) -> Vec<PlayerId> {
        match self.phase {
            Phase::Night => self
                .living_ids_where(|p| p.role() == Role::Werewolf)
                .into_iter()
                .filter(|id| !self.night_picks.contains_key(id))
                .collect(),
            Phase::Day => self
                .living_ids_where(|_| true)
                .into_iter()
                .filter(|id| !self.day_votes.contains_key(id))
                .collect(),
            Phase::Ended => Vec::new(),
        }
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

    // ----- internals --------------------------------------------------------

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
