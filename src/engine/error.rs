use std::fmt;

use super::{Phase, PlayerId};

/// Errors from constructing or commanding an [`Engine`](crate::Engine); on `Err` the game state is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameError {
    /// Fewer than [`Engine::MIN_PLAYERS`](crate::Engine::MIN_PLAYERS) players.
    TooFewPlayers { got: usize, min: usize },
    /// `with_roles` was handed a roster the game could never start from.
    InvalidRoster(&'static str),
    /// The id is outside `0..player_count`.
    UnknownPlayer(PlayerId),
    /// The actor or target is a player who has been eliminated.
    PlayerNotAlive(PlayerId),
    /// A non-werewolf tried to take the werewolves' night action.
    NotAWerewolf(PlayerId),
    /// The command is not legal in the current phase.
    WrongPhase { expected: Phase, actual: Phase },
    /// This player already cast their day vote, which is final.
    AlreadyActed(PlayerId),
    /// Resolution was attempted before every required actor had acted.
    ActionsIncomplete { waiting_on: Vec<PlayerId> },
    /// The game is over; no further commands are accepted.
    GameOver,
}

impl fmt::Display for GameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GameError::TooFewPlayers { got, min } => {
                write!(f, "need at least {min} players, got {got}")
            }
            GameError::InvalidRoster(why) => write!(f, "invalid roster: {why}"),
            GameError::UnknownPlayer(id) => write!(f, "no such player: {id}"),
            GameError::PlayerNotAlive(id) => write!(f, "player {id} is not alive"),
            GameError::NotAWerewolf(id) => write!(f, "player {id} is not a werewolf"),
            GameError::WrongPhase { expected, actual } => {
                write!(
                    f,
                    "command requires {expected:?} phase, but it is {actual:?}"
                )
            }
            GameError::AlreadyActed(id) => write!(f, "player {id} has already acted this phase"),
            GameError::ActionsIncomplete { waiting_on } => {
                write!(f, "still waiting on {waiting_on:?}")
            }
            GameError::GameOver => write!(f, "the game is over"),
        }
    }
}

impl std::error::Error for GameError {}
