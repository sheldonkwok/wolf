use std::collections::{BTreeMap, BTreeSet};

use crate::rng::{SplitMix64, time_seed};

mod error;
mod player;
#[cfg(test)]
mod structured_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod witch_tests;

pub use error::GameError;
pub use player::{Player, PlayerId, Role};

/// The current stage of the game.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Living night roles act, then the witch once the pack's target is locked; resolved with [`Engine::resolve_night`].
    Night,
    /// Players vote until a strict majority or a complete ballot; the seer may also inspect once on Day 1.
    Day,
    /// A team has won. No further commands are accepted.
    Ended,
    /// An eliminated hunter takes their final shot before play resumes.
    Hunter,
    /// A structured game opens by electing a sheriff, resolved with [`Engine::resolve_sheriff`].
    Sheriff,
}

/// Which rule set a game is played under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ruleset {
    /// Random special roles from [`Engine::SPECIAL_ROLES`]; every game opens on Day 1.
    Standard,
    /// The fixed 12-player roster of [`Engine::STRUCTURED_ROLES`] with a sheriff election and Night 1 last words.
    Structured,
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
    /// The night is over: `saved` is the attacked player if they lived, and `deaths` are in id order without causes.
    Dawn {
        saved: Option<PlayerId>,
        deaths: Vec<PlayerId>,
    },
    /// The pack named more than one target; nobody died and they pick again.
    NoConsensus { targets: Vec<PlayerId> },
    /// The pack's target is locked and the witch must act before the night can finish.
    AwaitingWitch,
}

/// The witch's decision for one night; she may use at most one potion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WitchChoice {
    /// Spend the heal potion on the werewolves' target.
    Heal,
    /// Spend the poison potion on a living player other than herself.
    Poison(PlayerId),
    /// Keep both potions.
    Pass,
}

/// A private seer result, retained for moderator inspection and reconnecting players.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inspection {
    pub seer: PlayerId,
    pub target: PlayerId,
    pub round: usize,
    /// [`Phase::Day`] for the Day 1 inspection, otherwise [`Phase::Night`].
    pub phase: Phase,
    pub is_werewolf: bool,
}

/// The result of resolving a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DayOutcome {
    /// The early majority or unique leader of a complete ballot was eliminated.
    Eliminated(PlayerId),
    /// A complete ballot tied for the most votes; nobody was eliminated.
    Tied,
    /// The voted-out Fool revealed their role and survives without a vote.
    FoolRevealed(PlayerId),
}

/// The result of the opening sheriff election.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheriffOutcome {
    /// The early majority or unique leader of a complete ballot holds the badge.
    Elected(PlayerId),
    /// A complete ballot tied for the most votes; the game has no sheriff.
    Tied,
}

/// The game engine and moderator: owns all state, built with [`Engine::new`] or [`Engine::with_roles`] and driven by the night/day commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Engine {
    players: Vec<Player>,
    ruleset: Ruleset,
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
    /// The pack's locked target while the witch takes her turn.
    attack: Option<PlayerId>,
    witch_choice: Option<WitchChoice>,
    heal_used: bool,
    poison_used: bool,
    /// Living voter -> their sheriff candidate during the opening election.
    sheriff_votes: BTreeMap<PlayerId, PlayerId>,
    sheriff: Option<PlayerId>,
    /// The Fool who survived a vote and can no longer vote.
    revealed_fool: Option<PlayerId>,
    /// Night 1 victims who may still share their last words.
    last_words: BTreeSet<PlayerId>,
}

impl Engine {
    /// The fewest players a game can be built with.
    pub const MIN_PLAYERS: usize = 5;

    /// The village roles a deal draws from; a roster holds at most one of each.
    pub const SPECIAL_ROLES: [Role; 4] = [Role::Doctor, Role::Seer, Role::Hunter, Role::Witch];

    /// The exact player count dealt under [`Ruleset::Structured`].
    pub const STRUCTURED_PLAYERS: usize = 12;

    /// The structured roster: four wolves, four villagers, and the Seer, Witch, Hunter, and Fool.
    pub const STRUCTURED_ROLES: [Role; 12] = [
        Role::Werewolf,
        Role::Werewolf,
        Role::Werewolf,
        Role::Werewolf,
        Role::Villager,
        Role::Villager,
        Role::Villager,
        Role::Villager,
        Role::Seer,
        Role::Witch,
        Role::Hunter,
        Role::Fool,
    ];

    /// Sheriff votes count as this many half votes; everyone else's count as two.
    const SHERIFF_HALVES: usize = 3;

    /// Deal `max(1, player_count / 3)` wolves and up to `max(2, floor(village_count * 33%))` distinct special village roles; exactly 12 players get the structured roster.
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

        let mut rng = SplitMix64::new(seed);
        if player_count == Self::STRUCTURED_PLAYERS {
            let mut roles = Self::STRUCTURED_ROLES;
            rng.shuffle(&mut roles);
            return Ok(Self::from_roles(&roles, Ruleset::Structured));
        }
        let wolves = (player_count / 3).max(1);
        let villagers = player_count - wolves;
        let mut special_roles = Self::SPECIAL_ROLES;
        let special_count = (villagers * 33 / 100).max(2).min(special_roles.len());
        rng.shuffle(&mut special_roles);
        let mut roles = Vec::with_capacity(player_count);
        roles.extend(std::iter::repeat_n(Role::Werewolf, wolves));
        roles.extend_from_slice(&special_roles[..special_count]);
        roles.extend(std::iter::repeat_n(
            Role::Villager,
            villagers - special_count,
        ));
        rng.shuffle(&mut roles);

        Ok(Self::from_roles(&roles, Ruleset::Standard))
    }

    /// Build a game from an exact role list (`roles[i]` is `Pi`), rejecting rosters the game could never begin from; this is the deterministic constructor tests use.
    pub fn with_roles(roles: &[Role]) -> Result<Self, GameError> {
        Self::with_ruleset(roles, Ruleset::Standard)
    }

    /// Like [`Engine::with_roles`] under `ruleset`; a structured roster must be a permutation of [`Engine::STRUCTURED_ROLES`].
    pub fn with_ruleset(roles: &[Role], ruleset: Ruleset) -> Result<Self, GameError> {
        if ruleset == Ruleset::Structured {
            let mut sorted = roles.to_vec();
            let mut expected = Self::STRUCTURED_ROLES.to_vec();
            sorted.sort_by_key(|r| *r as u8);
            expected.sort_by_key(|r| *r as u8);
            if sorted != expected {
                return Err(GameError::InvalidRoster(
                    "structured games need 4 werewolves, 4 villagers, a seer, a witch, a hunter, and a fool",
                ));
            }
        }
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
        for role in Self::SPECIAL_ROLES.into_iter().chain([Role::Fool]) {
            if roles.iter().filter(|r| **r == role).count() > 1 {
                return Err(GameError::InvalidRoster(
                    "at most one doctor, one seer, one hunter, one witch, and one fool are allowed",
                ));
            }
        }
        Ok(Self::from_roles(roles, ruleset))
    }

    fn from_roles(roles: &[Role], ruleset: Ruleset) -> Self {
        let players = roles
            .iter()
            .enumerate()
            .map(|(i, &role)| Player::new(PlayerId(i), role))
            .collect();
        Engine {
            players,
            ruleset,
            phase: match ruleset {
                Ruleset::Standard => Phase::Day,
                Ruleset::Structured => Phase::Sheriff,
            },
            round: 1,
            winner: None,
            night_picks: BTreeMap::new(),
            doctor_picks: BTreeMap::new(),
            seer_picks: BTreeMap::new(),
            inspections: Vec::new(),
            day_votes: BTreeMap::new(),
            pending_hunter: None,
            attack: None,
            witch_choice: None,
            heal_used: false,
            poison_used: false,
            sheriff_votes: BTreeMap::new(),
            sheriff: None,
            revealed_fool: None,
            last_words: BTreeSet::new(),
        }
    }

    // ----- commands -------------------------------------------------------

    /// Record one werewolf naming `target` for tonight's kill; a wolf may overwrite their pick until the pack's target is locked.
    pub fn night_action(&mut self, wolf: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Night)?;

        let actor = self.require_alive(wolf)?;
        if actor.role() != Role::Werewolf {
            return Err(GameError::NotAWerewolf(wolf));
        }
        self.require_alive(target)?;
        if self.attack.is_some() {
            return Err(GameError::AlreadyActed(wolf));
        }

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

    /// Inspect once on Day 1 and once per night; reveals only werewolf versus innocent.
    pub fn seer_action(
        &mut self,
        seer: PlayerId,
        target: PlayerId,
    ) -> Result<Inspection, GameError> {
        if !self.is_day_one() {
            self.ensure_phase(Phase::Night)?;
        }
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
            phase: self.phase,
            is_werewolf,
        };
        self.seer_picks.insert(seer, target);
        self.inspections.push(inspection);
        Ok(inspection)
    }

    /// The witch's turn once the pack's target is locked: heal it, poison someone else, or pass; the choice is final.
    pub fn witch_action(&mut self, witch: PlayerId, choice: WitchChoice) -> Result<(), GameError> {
        self.ensure_phase(Phase::Night)?;
        if self.require_alive(witch)?.role() != Role::Witch {
            return Err(GameError::NotAWitch(witch));
        }
        if self.witch_choice.is_some() {
            return Err(GameError::AlreadyActed(witch));
        }
        if self.attack.is_none() {
            return Err(GameError::PackUndecided);
        }
        match choice {
            WitchChoice::Heal => {
                if self.heal_used {
                    return Err(GameError::PotionSpent(witch));
                }
                self.heal_used = true;
            }
            WitchChoice::Poison(target) => {
                self.require_alive(target)?;
                if target == witch {
                    return Err(GameError::WitchCannotPoisonSelf);
                }
                if self.poison_used {
                    return Err(GameError::PotionSpent(witch));
                }
                self.poison_used = true;
            }
            WitchChoice::Pass => {}
        }
        self.witch_choice = Some(choice);
        Ok(())
    }

    /// Resolve the night: lock the pack's target, wait for a witch who still holds a potion, then apply deaths and advance.
    pub fn resolve_night(&mut self) -> Result<NightOutcome, GameError> {
        self.ensure_phase(Phase::Night)?;

        let waiting_on = self.pending_actors();
        if !waiting_on.is_empty() {
            return Err(GameError::ActionsIncomplete { waiting_on });
        }

        let target = match self.attack {
            Some(target) => target,
            None => {
                let targets: BTreeSet<PlayerId> = self
                    .living_ids_where(|p| p.role() == Role::Werewolf)
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
                if self.witch_can_act() {
                    self.attack = Some(target);
                    return Ok(NightOutcome::AwaitingWitch);
                }
                target
            }
        };

        let choice = self.witch_choice.take();
        let protected = self.doctor_picks.values().any(|&pick| pick == target);
        let mut deaths = BTreeSet::new();
        if !protected && choice != Some(WitchChoice::Heal) {
            deaths.insert(target);
        }
        if let Some(WitchChoice::Poison(poisoned)) = choice {
            deaths.insert(poisoned);
        }
        let deaths: Vec<PlayerId> = deaths.into_iter().collect();
        if self.ruleset == Ruleset::Structured && self.round == 1 {
            self.last_words.extend(deaths.iter().copied());
        }
        self.attack = None;
        self.night_picks.clear();
        self.doctor_picks.clear();
        self.seer_picks.clear();
        self.eliminate(&deaths, Phase::Day);
        Ok(NightOutcome::Dawn {
            saved: (!deaths.contains(&target)).then_some(target),
            deaths,
        })
    }

    /// Record or replace a living player's day vote for a living target; a revealed Fool cannot vote.
    pub fn vote(&mut self, voter: PlayerId, target: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Day)?;
        self.require_alive(voter)?;
        self.require_alive(target)?;
        if !self.can_vote(voter) {
            return Err(GameError::CannotVote(voter));
        }
        self.day_votes.insert(voter, target);
        Ok(())
    }

    /// Resolve an early majority or complete ballot, skipping any unused Day 1 inspection; a tie begins night and an unrevealed Fool survives.
    pub fn resolve_day(&mut self) -> Result<DayOutcome, GameError> {
        self.ensure_phase(Phase::Day)?;
        let target = self.ballot_result(&self.day_votes)?;
        self.day_votes.clear();
        self.seer_picks.clear();
        self.last_words.clear();
        match target {
            Some(target)
                if self.players[target.index()].role() == Role::Fool
                    && self.revealed_fool.is_none() =>
            {
                self.revealed_fool = Some(target);
                if self.sheriff == Some(target) {
                    self.sheriff = None;
                }
                self.resume(Phase::Night);
                Ok(DayOutcome::FoolRevealed(target))
            }
            Some(target) => {
                self.eliminate(&[target], Phase::Night);
                Ok(DayOutcome::Eliminated(target))
            }
            None => {
                self.resume(Phase::Night);
                Ok(DayOutcome::Tied)
            }
        }
    }

    /// Record or replace a living player's vote for a living sheriff candidate.
    pub fn sheriff_vote(&mut self, voter: PlayerId, candidate: PlayerId) -> Result<(), GameError> {
        self.ensure_phase(Phase::Sheriff)?;
        self.require_alive(voter)?;
        self.require_alive(candidate)?;
        self.sheriff_votes.insert(voter, candidate);
        Ok(())
    }

    /// Resolve the election like a day vote, then begin Day 1; a tie leaves the game without a sheriff.
    pub fn resolve_sheriff(&mut self) -> Result<SheriffOutcome, GameError> {
        self.ensure_phase(Phase::Sheriff)?;
        let winner = self.ballot_result(&self.sheriff_votes)?;
        self.sheriff_votes.clear();
        self.sheriff = winner;
        self.phase = Phase::Day;
        Ok(winner.map_or(SheriffOutcome::Tied, SheriffOutcome::Elected))
    }

    /// A Night 1 victim in a structured game shares their last words once, before Day 2 ends.
    pub fn last_words(&mut self, player: PlayerId) -> Result<(), GameError> {
        if self.phase == Phase::Ended {
            return Err(GameError::GameOver);
        }
        self.role_of(player)?;
        if !self.last_words.remove(&player) {
            return Err(GameError::NoLastWords(player));
        }
        Ok(())
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

    /// The current round: 1 for the first day and night, bumped after each night.
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

    /// The rule set this game is played under.
    pub fn ruleset(&self) -> Ruleset {
        self.ruleset
    }

    /// The living sheriff, if one was elected and still holds the badge.
    pub fn sheriff(&self) -> Option<PlayerId> {
        self.sheriff.filter(|&id| self.is_alive(id))
    }

    /// The Fool who survived a vote, if any; they stay alive without a vote.
    pub fn revealed_fool(&self) -> Option<PlayerId> {
        self.revealed_fool
    }

    /// Whether `id` is a living player who may vote; a revealed Fool may not.
    pub fn can_vote(&self, id: PlayerId) -> bool {
        self.is_alive(id) && self.revealed_fool != Some(id)
    }

    /// How much `voter`'s day vote counts: 1.5 for the sheriff, otherwise 1.
    pub fn vote_weight(&self, voter: PlayerId) -> f64 {
        self.vote_halves(voter) as f64 / 2.0
    }

    /// Night 1 victims who may still share their last words, in id order.
    pub fn pending_last_words(&self) -> Vec<PlayerId> {
        self.last_words.iter().copied().collect()
    }

    /// `(living village team including every special role, living werewolves)`.
    pub fn alive_count_by_role(&self) -> (usize, usize) {
        let mut villagers = 0;
        let mut wolves = 0;
        for p in self.alive() {
            match p.role() {
                Role::Villager
                | Role::Doctor
                | Role::Seer
                | Role::Hunter
                | Role::Witch
                | Role::Fool => villagers += 1,
                Role::Werewolf => wolves += 1,
            }
        }
        (villagers, wolves)
    }

    /// Actors still needed in the current phase, or nobody after ending.
    pub fn pending_actors(&self) -> Vec<PlayerId> {
        match self.phase {
            Phase::Night if self.attack.is_some() => {
                self.living_ids_where(|p| p.role() == Role::Witch && self.witch_choice.is_none())
            }
            Phase::Night => self.living_ids_where(|p| match p.role() {
                Role::Werewolf => !self.night_picks.contains_key(&p.id()),
                Role::Doctor => !self.doctor_picks.contains_key(&p.id()),
                Role::Seer => !self.seer_picks.contains_key(&p.id()),
                Role::Villager | Role::Hunter | Role::Witch | Role::Fool => false,
            }),
            Phase::Day => self.living_ids_where(|p| {
                self.can_vote(p.id()) && !self.day_votes.contains_key(&p.id())
            }),
            Phase::Sheriff => self.living_ids_where(|p| !self.sheriff_votes.contains_key(&p.id())),
            Phase::Hunter => vec![self.pending_hunter.expect("hunter phase has an actor").0],
            Phase::Ended => Vec::new(),
        }
    }

    /// Living seers who may still inspect now: optional on Day 1, required each night.
    pub fn pending_inspectors(&self) -> Vec<PlayerId> {
        if !self.is_day_one() && self.phase != Phase::Night {
            return Vec::new();
        }
        self.living_ids_where(|p| p.role() == Role::Seer && !self.seer_picks.contains_key(&p.id()))
    }

    /// Weighted votes needed for an early result: strictly more than half the living players who may vote.
    pub fn majority_required(&self) -> usize {
        self.living_ids_where(|p| self.can_vote(p.id())).len() / 2 + 1
    }

    /// The early majority target of the current day or sheriff ballot; adapters also resolve when no voters remain pending.
    pub fn majority_target(&self) -> Option<PlayerId> {
        let votes = match self.phase {
            Phase::Day => &self.day_votes,
            Phase::Sheriff => &self.sheriff_votes,
            _ => return None,
        };
        let needed = self.majority_required() * 2;
        self.tally(votes)
            .into_iter()
            .find(|&(_, halves)| halves >= needed)
            .map(|(target, _)| target)
    }

    /// Sheriff votes cast so far as `voter -> candidate`; empty outside the election.
    pub fn current_sheriff_votes(&self) -> BTreeMap<PlayerId, PlayerId> {
        self.sheriff_votes.clone()
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

    /// Whether the witch's heal potion is still unused.
    pub fn heal_available(&self) -> bool {
        !self.heal_used
    }

    /// Whether the witch's poison potion is still unused.
    pub fn poison_available(&self) -> bool {
        !self.poison_used
    }

    /// The pack's target, shown only to a witch on her pending turn while she still holds the heal potion.
    pub fn witch_victim(&self) -> Option<PlayerId> {
        self.attack
            .filter(|_| self.witch_choice.is_none() && !self.heal_used)
    }

    /// All private seer results; adapters must only disclose each result to its seer.
    pub fn inspections(&self) -> &[Inspection] {
        &self.inspections
    }

    // ----- internals --------------------------------------------------------

    /// Kill every target at once; a hunter among them shoots before play resumes at `next`.
    fn eliminate(&mut self, targets: &[PlayerId], next: Phase) {
        for target in targets {
            self.players[target.index()].kill();
        }
        let hunter = targets
            .iter()
            .find(|id| self.players[id.index()].role() == Role::Hunter);
        if let Some(&hunter) = hunter {
            self.pending_hunter = Some((hunter, next));
            self.phase = Phase::Hunter;
        } else {
            self.resume(next);
        }
    }

    /// Half votes per ballot: the sheriff's day vote counts three, everyone else's two.
    fn vote_halves(&self, voter: PlayerId) -> usize {
        if self.phase == Phase::Day && self.sheriff() == Some(voter) {
            Self::SHERIFF_HALVES
        } else {
            2
        }
    }

    /// Weighted half votes per target.
    fn tally(&self, votes: &BTreeMap<PlayerId, PlayerId>) -> BTreeMap<PlayerId, usize> {
        let mut tally = BTreeMap::new();
        for (&voter, &target) in votes {
            *tally.entry(target).or_insert(0) += self.vote_halves(voter);
        }
        tally
    }

    /// The early majority, else the unique leader once every eligible voter has voted; `None` is a tie.
    fn ballot_result(
        &self,
        votes: &BTreeMap<PlayerId, PlayerId>,
    ) -> Result<Option<PlayerId>, GameError> {
        if let Some(target) = self.majority_target() {
            return Ok(Some(target));
        }
        if !self.pending_actors().is_empty() {
            return Err(GameError::NoMajority);
        }
        let tally = self.tally(votes);
        let most = tally.values().copied().max().expect("living players voted");
        let mut leaders = tally.iter().filter(|(_, halves)| **halves == most);
        let (&leader, _) = leaders.next().expect("a leading target");
        Ok(leaders.next().is_none().then_some(leader))
    }

    /// A living witch takes a turn only while she still holds a potion.
    fn witch_can_act(&self) -> bool {
        !(self.heal_used && self.poison_used) && self.alive().any(|p| p.role() == Role::Witch)
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

    fn is_day_one(&self) -> bool {
        self.phase == Phase::Day && self.round == 1
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
