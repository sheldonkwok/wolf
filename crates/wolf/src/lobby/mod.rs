use crate::engine::{Engine, PlayerId};

mod error;
mod member;
#[cfg(test)]
mod tests;

pub use error::LobbyError;
pub use member::{Member, UserId};

/// Whether the lobby is still gathering players or has a game running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LobbyState {
    /// Players may still join and leave; the host may start a game.
    Waiting,
    /// A game is running; the roster is frozen until it ends.
    InGame,
}

/// A group of players waiting to start a game: members join in order, the first is the host, and only the host can [`start`](Lobby::start) the [`Engine`] the lobby then owns.
///
/// ```
/// use wolf::{Lobby, Phase, UserId};
///
/// let mut lobby = Lobby::new();
/// for who in ["u1", "u2", "u3", "u4", "u5"] {
///     lobby.join(UserId(who.to_string()), who).unwrap();
/// }
///
/// // The first to join hosts and holds seat 0.
/// let host = UserId("u1".to_string());
/// assert!(lobby.is_host(&host));
///
/// let game = lobby.start_with_seed(&host, 42).unwrap();
/// assert_eq!(game.phase(), Phase::Night);
///
/// // The lobby owns the engine; drive it through game_mut().
/// let seat = lobby.seat_of(&UserId("u3".to_string())).unwrap();
/// assert_eq!(lobby.member_at(seat).unwrap().name(), "u3");
/// let _ = lobby.game_mut().unwrap();
/// ```
#[derive(Debug, Clone)]
pub struct Lobby {
    /// Members in join order; `members[0]` is the host and index is the seat.
    members: Vec<Member>,
    game: Option<Engine>,
}

impl Default for Lobby {
    fn default() -> Self {
        Self::new()
    }
}

impl Lobby {
    /// The fewest members a game can start with, matching [`Engine::MIN_PLAYERS`].
    pub const MIN_PLAYERS: usize = Engine::MIN_PLAYERS;

    /// The most members a lobby holds, matching the top of the rules' player table.
    pub const MAX_PLAYERS: usize = 12;

    /// An empty lobby with no members and no game.
    pub fn new() -> Self {
        Lobby {
            members: Vec::new(),
            game: None,
        }
    }

    // ----- commands -------------------------------------------------------

    /// Add `user` under display name `name`; the first to join becomes the host.
    pub fn join(&mut self, user: UserId, name: impl Into<String>) -> Result<(), LobbyError> {
        if self.game.is_some() {
            return Err(LobbyError::GameInProgress);
        }
        if self.contains(&user) {
            return Err(LobbyError::AlreadyJoined(user));
        }
        if self.members.len() >= Self::MAX_PLAYERS {
            return Err(LobbyError::LobbyFull {
                max: Self::MAX_PLAYERS,
            });
        }
        self.members.push(Member::new(user, name.into()));
        Ok(())
    }

    /// Remove `user`; if they were the host, the next longest-waiting member is promoted.
    pub fn leave(&mut self, user: &UserId) -> Result<(), LobbyError> {
        if self.game.is_some() {
            return Err(LobbyError::GameInProgress);
        }
        let seat = self
            .index_of(user)
            .ok_or_else(|| LobbyError::NotInLobby(user.clone()))?;
        self.members.remove(seat);
        Ok(())
    }

    /// Start a game with random roles, seeded from the clock; only the host may call this.
    pub fn start(&mut self, host: &UserId) -> Result<&Engine, LobbyError> {
        self.check_can_start(host)?;
        let game = Engine::new(self.members.len()).expect("member count validated");
        Ok(self.game.insert(game))
    }

    /// Like [`Lobby::start`], but the deal is drawn from `seed` so the game can be reproduced.
    pub fn start_with_seed(&mut self, host: &UserId, seed: u64) -> Result<&Engine, LobbyError> {
        self.check_can_start(host)?;
        let game = Engine::with_seed(self.members.len(), seed).expect("member count validated");
        Ok(self.game.insert(game))
    }

    /// Clear a finished game and return to [`LobbyState::Waiting`] with the members intact.
    pub fn end_game(&mut self) -> Result<(), LobbyError> {
        match &self.game {
            None => Err(LobbyError::NoGame),
            Some(game) if !game.is_over() => Err(LobbyError::GameNotOver),
            Some(_) => {
                self.game = None;
                Ok(())
            }
        }
    }

    // ----- inspection ---------------------------------------------------------

    /// Whether the lobby is waiting for players or running a game.
    pub fn state(&self) -> LobbyState {
        if self.game.is_some() {
            LobbyState::InGame
        } else {
            LobbyState::Waiting
        }
    }

    /// The running game, or `None` while the lobby is waiting.
    pub fn game(&self) -> Option<&Engine> {
        self.game.as_ref()
    }

    /// The running game for issuing commands, or `None` while the lobby is waiting.
    pub fn game_mut(&mut self) -> Option<&mut Engine> {
        self.game.as_mut()
    }

    /// Every member, in join order; a member's index is their seat in the game.
    pub fn members(&self) -> &[Member] {
        &self.members
    }

    /// How many members are in the lobby.
    pub fn len(&self) -> usize {
        self.members.len()
    }

    /// Whether the lobby has no members.
    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    /// The host, or `None` if the lobby is empty.
    pub fn host(&self) -> Option<&Member> {
        self.members.first()
    }

    /// Whether `user` is the current host.
    pub fn is_host(&self, user: &UserId) -> bool {
        self.host().is_some_and(|h| h.user() == user)
    }

    /// Whether `user` is a member of the lobby.
    pub fn contains(&self, user: &UserId) -> bool {
        self.index_of(user).is_some()
    }

    /// The seat `user` holds, or `None` if they are not a member; the seat is provisional until a game starts.
    pub fn seat_of(&self, user: &UserId) -> Option<PlayerId> {
        self.index_of(user).map(PlayerId)
    }

    /// The member sitting in `seat`, or `None` if the seat is out of range.
    pub fn member_at(&self, seat: PlayerId) -> Option<&Member> {
        self.members.get(seat.index())
    }

    /// Whether the host could start a game right now.
    pub fn can_start(&self) -> bool {
        self.game.is_none() && self.members.len() >= Self::MIN_PLAYERS
    }

    // ----- internals --------------------------------------------------------

    fn index_of(&self, user: &UserId) -> Option<usize> {
        self.members.iter().position(|m| m.user() == user)
    }

    /// The shared gate for both start paths: no game running, caller is host, enough members.
    fn check_can_start(&self, host: &UserId) -> Result<(), LobbyError> {
        if self.game.is_some() {
            return Err(LobbyError::GameInProgress);
        }
        if !self.is_host(host) {
            return Err(LobbyError::NotHost(host.clone()));
        }
        if self.members.len() < Self::MIN_PLAYERS {
            return Err(LobbyError::TooFewPlayers {
                got: self.members.len(),
                min: Self::MIN_PLAYERS,
            });
        }
        Ok(())
    }
}
