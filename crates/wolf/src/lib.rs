//! Wolf — a werewolf / mafia game engine: four roles ([`Role::Villager`], [`Role::Werewolf`], [`Role::Doctor`], [`Role::Seer`]) with the [`Engine`] as moderator, owning all state behind read-only accessors and validating every command.
//!
//! A wolf may revise their night pick at any time before the night resolves; a split pack resolves to [`NightOutcome::NoConsensus`] and picks again rather than deadlocking.
//!
//! ```
//! use wolf::{Engine, Role, Winner};
//!
//! // P0 and P6 are wolves; the other five are villagers.
//! let roles = [
//!     Role::Werewolf, Role::Villager, Role::Villager, Role::Villager,
//!     Role::Villager, Role::Villager, Role::Werewolf,
//! ];
//! let mut game = Engine::with_roles(&roles).unwrap();
//!
//! // Day 1: a majority is ready, then everyone votes to lynch wolf P0.
//! for player in [0, 1, 2, 3] {
//!     game.ready_to_vote(game.player(player)).unwrap();
//! }
//! for voter in 0..7 {
//!     game.vote(game.player(voter), game.player(0)).unwrap();
//! }
//! game.resolve_day().unwrap();
//!
//! // Night 1: the surviving wolf kills P1, then Day 2 begins.
//! game.night_action(game.player(6), game.player(1)).unwrap();
//! game.resolve_night().unwrap();
//! assert_eq!(game.winner(), None); // one wolf still at large
//! ```

mod engine;
pub mod rng;

pub use engine::{
    DayOutcome, Engine, GameError, Inspection, NightOutcome, Phase, Player, PlayerId, Role, Winner,
};
