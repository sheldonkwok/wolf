//! Wolf — a werewolf / mafia game engine.
//!
//! This first slice implements the simplest rule set: two roles, [`Role::Villager`]
//! and [`Role::Werewolf`]. The [`Engine`] plays the part of the moderator from the
//! rules: it owns the full game state, exposes read-only accessors so a chat bot
//! can render the game, and moves state forward through a small set of commands
//! that validate every input.
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
mod rng;

pub use engine::{DayOutcome, Engine, NightOutcome, Phase, Winner};
pub use error::GameError;
pub use player::{Player, PlayerId, Role};
