use std::fmt;

use super::UserId;

/// Errors from joining, leaving, or commanding a [`Lobby`](crate::Lobby); on `Err` the lobby is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LobbyError {
    /// This user is already a member of the lobby.
    AlreadyJoined(UserId),
    /// This user is not a member of the lobby.
    NotInLobby(UserId),
    /// The lobby is already at [`Lobby::MAX_PLAYERS`](crate::Lobby::MAX_PLAYERS).
    LobbyFull { max: usize },
    /// A non-host tried to take a host-only action.
    NotHost(UserId),
    /// The action is not allowed while a game is running.
    GameInProgress,
    /// The action needs a running game and there is none.
    NoGame,
    /// The game is still going, so it cannot be cleared yet.
    GameNotOver,
    /// Fewer than [`Lobby::MIN_PLAYERS`](crate::Lobby::MIN_PLAYERS) members to start a game.
    TooFewPlayers { got: usize, min: usize },
}

impl fmt::Display for LobbyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LobbyError::AlreadyJoined(user) => write!(f, "user {user} is already in the lobby"),
            LobbyError::NotInLobby(user) => write!(f, "user {user} is not in the lobby"),
            LobbyError::LobbyFull { max } => write!(f, "the lobby is full at {max} players"),
            LobbyError::NotHost(user) => write!(f, "user {user} is not the host"),
            LobbyError::GameInProgress => write!(f, "a game is already in progress"),
            LobbyError::NoGame => write!(f, "there is no game running"),
            LobbyError::GameNotOver => write!(f, "the game is not over yet"),
            LobbyError::TooFewPlayers { got, min } => {
                write!(f, "need at least {min} players, got {got}")
            }
        }
    }
}

impl std::error::Error for LobbyError {}
