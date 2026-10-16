//! napi-rs bindings: a thin, camelCased shell over the `wolf` engine plus its PRNG, with every `GameError` surfaced as a thrown JS error tagged `"<Code>: <message>"`.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;

use wolf::rng::{self, SplitMix64};
use wolf::{
    DayOutcome, Engine, GameError, NightOutcome, Phase as EnginePhase, PlayerId,
    Role as EngineRole, Ruleset as EngineRuleset, SheriffOutcome, Winner as EngineWinner,
    WitchChoice,
};

// ----- enums (cross as TS string unions) --------------------------------------

#[napi(string_enum)]
pub enum Role {
    Villager,
    Werewolf,
    Doctor,
    Seer,
    Hunter,
    Witch,
    Fool,
}

#[napi(string_enum)]
pub enum Phase {
    Night,
    Day,
    Ended,
    Hunter,
    Sheriff,
}

#[napi(string_enum)]
pub enum Ruleset {
    Standard,
    Structured,
}

#[napi(string_enum)]
pub enum Winner {
    Villagers,
    Werewolves,
}

#[napi(string_enum)]
pub enum NightKind {
    Dawn,
    NoConsensus,
    AwaitingWitch,
}

#[napi(string_enum)]
pub enum DayKind {
    Eliminated,
    Tied,
    FoolRevealed,
}

#[napi(string_enum)]
pub enum SheriffKind {
    Elected,
    Tied,
}

impl From<EngineRole> for Role {
    fn from(r: EngineRole) -> Self {
        match r {
            EngineRole::Villager => Role::Villager,
            EngineRole::Werewolf => Role::Werewolf,
            EngineRole::Doctor => Role::Doctor,
            EngineRole::Seer => Role::Seer,
            EngineRole::Hunter => Role::Hunter,
            EngineRole::Witch => Role::Witch,
            EngineRole::Fool => Role::Fool,
        }
    }
}

impl From<Role> for EngineRole {
    fn from(r: Role) -> Self {
        match r {
            Role::Villager => EngineRole::Villager,
            Role::Werewolf => EngineRole::Werewolf,
            Role::Doctor => EngineRole::Doctor,
            Role::Seer => EngineRole::Seer,
            Role::Hunter => EngineRole::Hunter,
            Role::Witch => EngineRole::Witch,
            Role::Fool => EngineRole::Fool,
        }
    }
}

impl From<EnginePhase> for Phase {
    fn from(p: EnginePhase) -> Self {
        match p {
            EnginePhase::Night => Phase::Night,
            EnginePhase::Day => Phase::Day,
            EnginePhase::Ended => Phase::Ended,
            EnginePhase::Hunter => Phase::Hunter,
            EnginePhase::Sheriff => Phase::Sheriff,
        }
    }
}

impl From<EngineRuleset> for Ruleset {
    fn from(r: EngineRuleset) -> Self {
        match r {
            EngineRuleset::Standard => Ruleset::Standard,
            EngineRuleset::Structured => Ruleset::Structured,
        }
    }
}

impl From<Ruleset> for EngineRuleset {
    fn from(r: Ruleset) -> Self {
        match r {
            Ruleset::Standard => EngineRuleset::Standard,
            Ruleset::Structured => EngineRuleset::Structured,
        }
    }
}

impl From<EngineWinner> for Winner {
    fn from(w: EngineWinner) -> Self {
        match w {
            EngineWinner::Villagers => Winner::Villagers,
            EngineWinner::Werewolves => Winner::Werewolves,
        }
    }
}

// ----- plain objects --------------------------------------------------------

#[napi(object)]
pub struct PlayerView {
    pub id: u32,
    pub role: Role,
    pub alive: bool,
    /// False once dead or revealed as the Fool.
    pub can_vote: bool,
    /// 1.5 for the sheriff during the day, otherwise 1.
    pub vote_weight: f64,
}

#[napi(object)]
pub struct VoteView {
    pub voter: u32,
    pub target: u32,
}

#[napi(object)]
pub struct NightResult {
    pub kind: NightKind,
    pub saved: Option<u32>,
    pub deaths: Vec<u32>,
    pub targets: Vec<u32>,
}

#[napi(object)]
pub struct DayResult {
    pub kind: DayKind,
    pub eliminated: Option<u32>,
    pub fool: Option<u32>,
}

#[napi(object)]
pub struct SheriffResult {
    pub kind: SheriffKind,
    pub sheriff: Option<u32>,
}

#[napi(object)]
pub struct InspectionView {
    pub seer: u32,
    pub target: u32,
    pub round: u32,
    pub phase: Phase,
    pub is_werewolf: bool,
}

impl From<wolf::Inspection> for InspectionView {
    fn from(result: wolf::Inspection) -> Self {
        Self {
            seer: seat(result.seer),
            target: seat(result.target),
            round: result.round as u32,
            phase: result.phase.into(),
            is_werewolf: result.is_werewolf,
        }
    }
}

#[napi(object)]
pub struct GameState {
    pub ruleset: Ruleset,
    pub phase: Phase,
    pub round: u32,
    pub winner: Option<Winner>,
    pub is_over: bool,
    pub players: Vec<PlayerView>,
    pub pending_actors: Vec<u32>,
    pub pending_inspectors: Vec<u32>,
    pub majority_required: u32,
    pub majority_target: Option<u32>,
    pub votes: Vec<VoteView>,
    pub night_picks: Vec<VoteView>,
    pub doctor_picks: Vec<VoteView>,
    pub inspections: Vec<InspectionView>,
    pub heal_available: bool,
    pub poison_available: bool,
    pub witch_victim: Option<u32>,
    pub alive_villagers: u32,
    pub alive_wolves: u32,
    pub sheriff: Option<u32>,
    pub sheriff_votes: Vec<VoteView>,
    pub revealed_fool: Option<u32>,
    pub last_words: Vec<u32>,
}

// ----- conversions from engine outcomes -------------------------------------

fn seat(id: PlayerId) -> u32 {
    id.index() as u32
}

fn night_result(outcome: NightOutcome) -> NightResult {
    match outcome {
        NightOutcome::Dawn { saved, deaths } => NightResult {
            kind: NightKind::Dawn,
            saved: saved.map(seat),
            deaths: deaths.into_iter().map(seat).collect(),
            targets: Vec::new(),
        },
        NightOutcome::NoConsensus { targets } => NightResult {
            kind: NightKind::NoConsensus,
            saved: None,
            deaths: Vec::new(),
            targets: targets.into_iter().map(seat).collect(),
        },
        NightOutcome::AwaitingWitch => NightResult {
            kind: NightKind::AwaitingWitch,
            saved: None,
            deaths: Vec::new(),
            targets: Vec::new(),
        },
    }
}

fn day_result(outcome: DayOutcome) -> DayResult {
    match outcome {
        DayOutcome::Eliminated(id) => DayResult {
            kind: DayKind::Eliminated,
            eliminated: Some(seat(id)),
            fool: None,
        },
        DayOutcome::Tied => DayResult {
            kind: DayKind::Tied,
            eliminated: None,
            fool: None,
        },
        DayOutcome::FoolRevealed(id) => DayResult {
            kind: DayKind::FoolRevealed,
            eliminated: None,
            fool: Some(seat(id)),
        },
    }
}

fn sheriff_result(outcome: SheriffOutcome) -> SheriffResult {
    match outcome {
        SheriffOutcome::Elected(id) => SheriffResult {
            kind: SheriffKind::Elected,
            sheriff: Some(seat(id)),
        },
        SheriffOutcome::Tied => SheriffResult {
            kind: SheriffKind::Tied,
            sheriff: None,
        },
    }
}

fn votes_to_views(pairs: impl IntoIterator<Item = (PlayerId, PlayerId)>) -> Vec<VoteView> {
    pairs
        .into_iter()
        .map(|(voter, target)| VoteView {
            voter: seat(voter),
            target: seat(target),
        })
        .collect()
}

// ----- error bridge -------------------------------------------------------

/// The stable tag prefixed to every thrown game error; generated into the TS `GameErrorCode` union.
#[napi(string_enum)]
#[derive(Debug)]
pub enum GameErrorCode {
    TooFewPlayers,
    InvalidRoster,
    UnknownPlayer,
    PlayerNotAlive,
    NotAWerewolf,
    NotADoctor,
    NotASeer,
    NotAWitch,
    PackUndecided,
    PotionSpent,
    WitchCannotPoisonSelf,
    NotPendingHunter,
    LastWolfCannotTargetSelf,
    WrongPhase,
    AlreadyActed,
    NoMajority,
    ActionsIncomplete,
    CannotVote,
    NoLastWords,
    GameOver,
}

impl From<&GameError> for GameErrorCode {
    fn from(e: &GameError) -> Self {
        match e {
            GameError::TooFewPlayers { .. } => GameErrorCode::TooFewPlayers,
            GameError::InvalidRoster(_) => GameErrorCode::InvalidRoster,
            GameError::UnknownPlayer(_) => GameErrorCode::UnknownPlayer,
            GameError::PlayerNotAlive(_) => GameErrorCode::PlayerNotAlive,
            GameError::NotAWerewolf(_) => GameErrorCode::NotAWerewolf,
            GameError::NotADoctor(_) => GameErrorCode::NotADoctor,
            GameError::NotASeer(_) => GameErrorCode::NotASeer,
            GameError::NotAWitch(_) => GameErrorCode::NotAWitch,
            GameError::PackUndecided => GameErrorCode::PackUndecided,
            GameError::PotionSpent(_) => GameErrorCode::PotionSpent,
            GameError::WitchCannotPoisonSelf => GameErrorCode::WitchCannotPoisonSelf,
            GameError::NotPendingHunter(_) => GameErrorCode::NotPendingHunter,
            GameError::LastWolfCannotTargetSelf => GameErrorCode::LastWolfCannotTargetSelf,
            GameError::WrongPhase { .. } => GameErrorCode::WrongPhase,
            GameError::AlreadyActed(_) => GameErrorCode::AlreadyActed,
            GameError::NoMajority => GameErrorCode::NoMajority,
            GameError::ActionsIncomplete { .. } => GameErrorCode::ActionsIncomplete,
            GameError::CannotVote(_) => GameErrorCode::CannotVote,
            GameError::NoLastWords(_) => GameErrorCode::NoLastWords,
            GameError::GameOver => GameErrorCode::GameOver,
        }
    }
}

fn to_js(e: GameError) -> napi::Error {
    napi::Error::from_reason(format!("{:?}: {e}", GameErrorCode::from(&e)))
}

// ----- Game ------------------------------------------------------------------

/// The fewest players a game can be built with.
#[napi]
pub const MIN_PLAYERS: u32 = Engine::MIN_PLAYERS as u32;

#[napi]
pub struct Game {
    inner: Engine,
}

#[napi]
impl Game {
    /// Build a game for `player_count` players with a clock-seeded random deal.
    #[napi(constructor)]
    pub fn new(player_count: u32) -> napi::Result<Self> {
        Engine::new(player_count as usize)
            .map(|inner| Game { inner })
            .map_err(to_js)
    }

    /// Build a game whose deal is drawn from `seed`, so it can be reproduced.
    #[napi(factory)]
    pub fn with_seed(player_count: u32, seed: BigInt) -> napi::Result<Self> {
        Engine::with_seed(player_count as usize, seed.get_u64().1)
            .map(|inner| Game { inner })
            .map_err(to_js)
    }

    /// Build a game from an exact role list, where `roles[i]` is seat `i`.
    #[napi(factory)]
    pub fn with_roles(roles: Vec<Role>) -> napi::Result<Self> {
        let roles: Vec<EngineRole> = roles.into_iter().map(Into::into).collect();
        Engine::with_roles(&roles)
            .map(|inner| Game { inner })
            .map_err(to_js)
    }

    /// Build a game from an exact role list under `ruleset`; structured rosters must match the 12-player deal.
    #[napi(factory)]
    pub fn with_ruleset(roles: Vec<Role>, ruleset: Ruleset) -> napi::Result<Self> {
        let roles: Vec<EngineRole> = roles.into_iter().map(Into::into).collect();
        Engine::with_ruleset(&roles, ruleset.into())
            .map(|inner| Game { inner })
            .map_err(to_js)
    }

    /// Record or replace `voter`'s sheriff vote for `candidate`.
    #[napi]
    pub fn sheriff_vote(&mut self, voter: u32, candidate: u32) -> napi::Result<()> {
        self.inner
            .sheriff_vote(PlayerId(voter as usize), PlayerId(candidate as usize))
            .map_err(to_js)
    }

    /// Resolve the sheriff election and begin Day 1.
    #[napi]
    pub fn resolve_sheriff(&mut self) -> napi::Result<SheriffResult> {
        self.inner
            .resolve_sheriff()
            .map(sheriff_result)
            .map_err(to_js)
    }

    /// Spend a Night 1 victim's one chance at last words.
    #[napi]
    pub fn last_words(&mut self, player: u32) -> napi::Result<()> {
        self.inner
            .last_words(PlayerId(player as usize))
            .map_err(to_js)
    }

    /// Record one werewolf naming `target`; a wolf may overwrite their pick until the night resolves.
    #[napi]
    pub fn night_action(&mut self, wolf: u32, target: u32) -> napi::Result<()> {
        self.inner
            .night_action(PlayerId(wolf as usize), PlayerId(target as usize))
            .map_err(to_js)
    }

    /// Protect one living player for this night.
    #[napi]
    pub fn doctor_action(&mut self, doctor: u32, target: u32) -> napi::Result<()> {
        self.inner
            .doctor_action(PlayerId(doctor as usize), PlayerId(target as usize))
            .map_err(to_js)
    }

    /// Inspect one living player and return their private alignment result.
    #[napi]
    pub fn seer_action(&mut self, seer: u32, target: u32) -> napi::Result<InspectionView> {
        self.inner
            .seer_action(PlayerId(seer as usize), PlayerId(target as usize))
            .map(Into::into)
            .map_err(to_js)
    }

    /// Spend the witch's heal potion on the pack's locked target.
    #[napi]
    pub fn witch_heal(&mut self, witch: u32) -> napi::Result<()> {
        self.inner
            .witch_action(PlayerId(witch as usize), WitchChoice::Heal)
            .map_err(to_js)
    }

    /// Spend the witch's poison potion on `target`.
    #[napi]
    pub fn witch_poison(&mut self, witch: u32, target: u32) -> napi::Result<()> {
        let choice = WitchChoice::Poison(PlayerId(target as usize));
        self.inner
            .witch_action(PlayerId(witch as usize), choice)
            .map_err(to_js)
    }

    /// End the witch's turn without using a potion.
    #[napi]
    pub fn witch_pass(&mut self, witch: u32) -> napi::Result<()> {
        self.inner
            .witch_action(PlayerId(witch as usize), WitchChoice::Pass)
            .map_err(to_js)
    }

    /// Take the eliminated hunter's final shot.
    #[napi]
    pub fn hunter_action(&mut self, hunter: u32, target: u32) -> napi::Result<()> {
        self.inner
            .hunter_action(PlayerId(hunter as usize), PlayerId(target as usize))
            .map_err(to_js)
    }

    /// Resolve the night, pausing first for a witch who still holds a potion.
    #[napi]
    pub fn resolve_night(&mut self) -> napi::Result<NightResult> {
        self.inner.resolve_night().map(night_result).map_err(to_js)
    }

    /// Record or replace `voter`'s day vote for `target`.
    #[napi]
    pub fn vote(&mut self, voter: u32, target: u32) -> napi::Result<()> {
        self.inner
            .vote(PlayerId(voter as usize), PlayerId(target as usize))
            .map_err(to_js)
    }

    /// Resolve the day and advance the phase.
    #[napi]
    pub fn resolve_day(&mut self) -> napi::Result<DayResult> {
        self.inner.resolve_day().map(day_result).map_err(to_js)
    }

    /// The role dealt to seat `id`.
    #[napi]
    pub fn role_of(&self, id: u32) -> napi::Result<Role> {
        self.inner
            .role_of(PlayerId(id as usize))
            .map(Into::into)
            .map_err(to_js)
    }

    /// Whether seat `id` is a living player; `false` for unknown seats.
    #[napi]
    pub fn is_alive(&self, id: u32) -> bool {
        self.inner.is_alive(PlayerId(id as usize))
    }

    /// A full snapshot of the game, composed from the engine's à-la-carte accessors.
    #[napi]
    pub fn state(&self) -> GameState {
        let e = &self.inner;
        let players = e
            .players()
            .iter()
            .map(|p| PlayerView {
                id: seat(p.id()),
                role: p.role().into(),
                alive: p.is_alive(),
                can_vote: e.can_vote(p.id()),
                vote_weight: e.vote_weight(p.id()),
            })
            .collect();
        let (villagers, wolves) = e.alive_count_by_role();
        GameState {
            ruleset: e.ruleset().into(),
            phase: e.phase().into(),
            round: e.round() as u32,
            winner: e.winner().map(Into::into),
            is_over: e.is_over(),
            players,
            pending_actors: e.pending_actors().into_iter().map(seat).collect(),
            pending_inspectors: e.pending_inspectors().into_iter().map(seat).collect(),
            majority_required: e.majority_required() as u32,
            majority_target: e.majority_target().map(seat),
            votes: votes_to_views(e.current_votes()),
            night_picks: votes_to_views(e.current_night_picks()),
            doctor_picks: votes_to_views(e.current_doctor_picks()),
            inspections: e.inspections().iter().copied().map(Into::into).collect(),
            heal_available: e.heal_available(),
            poison_available: e.poison_available(),
            witch_victim: e.witch_victim().map(seat),
            alive_villagers: villagers as u32,
            alive_wolves: wolves as u32,
            sheriff: e.sheriff().map(seat),
            sheriff_votes: votes_to_views(e.current_sheriff_votes()),
            revealed_fool: e.revealed_fool().map(seat),
            last_words: e.pending_last_words().into_iter().map(seat).collect(),
        }
    }
}

// ----- Rng -----------------------------------------------------------------

#[napi]
pub struct Rng {
    inner: SplitMix64,
}

#[napi]
impl Rng {
    /// A SplitMix64 stream seeded from `seed`.
    #[napi(constructor)]
    pub fn new(seed: BigInt) -> Self {
        Rng {
            inner: SplitMix64::new(seed.get_u64().1),
        }
    }

    /// A uniform integer in `0..bound`.
    #[napi]
    pub fn below(&mut self, bound: u32) -> u32 {
        self.inner.below(bound as u64) as u32
    }

    /// `true` with probability `percent/100`.
    #[napi]
    pub fn chance(&mut self, percent: u32) -> bool {
        self.inner.chance(percent as u64)
    }
}

/// A seed derived from the wall clock, for a non-deterministic game.
#[napi]
pub fn time_seed() -> BigInt {
    BigInt::from(rng::time_seed())
}
