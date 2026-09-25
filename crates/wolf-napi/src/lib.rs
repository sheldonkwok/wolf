//! napi-rs bindings: a thin, camelCased shell over the `wolf` engine plus its PRNG, with every `GameError` surfaced as a thrown JS error tagged `"<Code>: <message>"`.

use napi::bindgen_prelude::BigInt;
use napi_derive::napi;

use wolf::rng::{self, SplitMix64};
use wolf::{
    DayOutcome, Engine, GameError, NightOutcome, Phase as EnginePhase, PlayerId,
    Role as EngineRole, Winner as EngineWinner,
};

// ----- enums (cross as TS string unions) --------------------------------------

#[napi(string_enum)]
pub enum Role {
    Villager,
    Werewolf,
    Doctor,
    Seer,
    Hunter,
}

#[napi(string_enum)]
pub enum Phase {
    Opening,
    Night,
    Day,
    Ended,
    Hunter,
}

#[napi(string_enum)]
pub enum Winner {
    Villagers,
    Werewolves,
}

#[napi(string_enum)]
pub enum NightKind {
    Killed,
    Saved,
    NoConsensus,
}

#[napi(string_enum)]
pub enum DayKind {
    Eliminated,
}

impl From<EngineRole> for Role {
    fn from(r: EngineRole) -> Self {
        match r {
            EngineRole::Villager => Role::Villager,
            EngineRole::Werewolf => Role::Werewolf,
            EngineRole::Doctor => Role::Doctor,
            EngineRole::Seer => Role::Seer,
            EngineRole::Hunter => Role::Hunter,
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
        }
    }
}

impl From<EnginePhase> for Phase {
    fn from(p: EnginePhase) -> Self {
        match p {
            EnginePhase::Opening => Phase::Opening,
            EnginePhase::Night => Phase::Night,
            EnginePhase::Day => Phase::Day,
            EnginePhase::Ended => Phase::Ended,
            EnginePhase::Hunter => Phase::Hunter,
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
}

#[napi(object)]
pub struct VoteView {
    pub voter: u32,
    pub target: u32,
}

#[napi(object)]
pub struct NightResult {
    pub kind: NightKind,
    pub killed: Option<u32>,
    pub saved: Option<u32>,
    pub targets: Vec<u32>,
}

#[napi(object)]
pub struct DayResult {
    pub kind: DayKind,
    pub eliminated: Option<u32>,
}

#[napi(object)]
pub struct InspectionView {
    pub seer: u32,
    pub target: u32,
    pub round: u32,
    pub is_werewolf: bool,
}

impl From<wolf::Inspection> for InspectionView {
    fn from(result: wolf::Inspection) -> Self {
        Self {
            seer: seat(result.seer),
            target: seat(result.target),
            round: result.round as u32,
            is_werewolf: result.is_werewolf,
        }
    }
}

#[napi(object)]
pub struct GameState {
    pub phase: Phase,
    pub round: u32,
    pub winner: Option<Winner>,
    pub is_over: bool,
    pub players: Vec<PlayerView>,
    pub pending_actors: Vec<u32>,
    pub majority_required: u32,
    pub majority_target: Option<u32>,
    pub votes: Vec<VoteView>,
    pub night_picks: Vec<VoteView>,
    pub doctor_picks: Vec<VoteView>,
    pub inspections: Vec<InspectionView>,
    pub alive_villagers: u32,
    pub alive_wolves: u32,
}

// ----- conversions from engine outcomes -------------------------------------

fn seat(id: PlayerId) -> u32 {
    id.index() as u32
}

fn night_result(outcome: NightOutcome) -> NightResult {
    match outcome {
        NightOutcome::Killed(id) => NightResult {
            kind: NightKind::Killed,
            killed: Some(seat(id)),
            saved: None,
            targets: Vec::new(),
        },
        NightOutcome::Saved(id) => NightResult {
            kind: NightKind::Saved,
            killed: None,
            saved: Some(seat(id)),
            targets: Vec::new(),
        },
        NightOutcome::NoConsensus { targets } => NightResult {
            kind: NightKind::NoConsensus,
            killed: None,
            saved: None,
            targets: targets.into_iter().map(seat).collect(),
        },
    }
}

fn day_result(outcome: DayOutcome) -> DayResult {
    match outcome {
        DayOutcome::Eliminated(id) => DayResult {
            kind: DayKind::Eliminated,
            eliminated: Some(seat(id)),
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

fn to_js(e: GameError) -> napi::Error {
    napi::Error::from_reason(format!("{}: {e}", e.code()))
}

// ----- Game ------------------------------------------------------------------

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

    /// Take the eliminated hunter's final shot.
    #[napi]
    pub fn hunter_action(&mut self, hunter: u32, target: u32) -> napi::Result<()> {
        self.inner
            .hunter_action(PlayerId(hunter as usize), PlayerId(target as usize))
            .map_err(to_js)
    }

    /// End the timed opening, skipping any unsubmitted inspection.
    #[napi]
    pub fn resolve_opening(&mut self) -> napi::Result<()> {
        self.inner.resolve_opening().map_err(to_js)
    }

    /// Resolve the night and advance the phase.
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
            })
            .collect();
        let (villagers, wolves) = e.alive_count_by_role();
        GameState {
            phase: e.phase().into(),
            round: e.round() as u32,
            winner: e.winner().map(Into::into),
            is_over: e.is_over(),
            players,
            pending_actors: e.pending_actors().into_iter().map(seat).collect(),
            majority_required: e.majority_required() as u32,
            majority_target: e.majority_target().map(seat),
            votes: votes_to_views(e.current_votes()),
            night_picks: votes_to_views(e.current_night_picks()),
            doctor_picks: votes_to_views(e.current_doctor_picks()),
            inspections: e.inspections().iter().copied().map(Into::into).collect(),
            alive_villagers: villagers as u32,
            alive_wolves: wolves as u32,
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
