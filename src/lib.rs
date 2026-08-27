//! Wolf — a werewolf / mafia game engine: two roles ([`Role::Villager`], [`Role::Werewolf`]) with the [`Engine`] as moderator, owning all state behind read-only accessors and validating every command.
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
//! // Night 1: both wolves agree to kill P1.
//! game.night_action(game.player(0), game.player(1)).unwrap();
//! game.night_action(game.player(6), game.player(1)).unwrap();
//! game.resolve_night().unwrap();
//!
//! // Day 1: every living player votes; the town lynches wolf P0.
//! for voter in [0, 2, 3, 4, 5, 6] {
//!     game.vote(game.player(voter), game.player(0)).unwrap();
//! }
//! game.resolve_day().unwrap();
//! assert_eq!(game.winner(), None); // one wolf still at large
//! ```

mod engine;
mod error;
mod player;
pub mod rng;

pub use engine::{DayOutcome, Engine, NightOutcome, Phase, Winner};
pub use error::GameError;
pub use player::{Player, PlayerId, Role};
