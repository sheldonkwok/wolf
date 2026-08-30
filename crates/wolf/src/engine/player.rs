use std::fmt;

/// A stable player handle assigned as `0..player_count`; displays as `P0`, `P1`, ...
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlayerId(pub usize);

impl PlayerId {
    /// The raw index behind the id.
    pub fn index(self) -> usize {
        self.0
    }
}

impl fmt::Display for PlayerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "P{}", self.0)
    }
}

/// The role a player was dealt. This slice only has the two core roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Villager,
    Werewolf,
}

/// A player and everything the engine tracks about them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Player {
    id: PlayerId,
    role: Role,
    alive: bool,
}

impl Player {
    pub(crate) fn new(id: PlayerId, role: Role) -> Self {
        Player {
            id,
            role,
            alive: true,
        }
    }

    pub fn id(&self) -> PlayerId {
        self.id
    }

    pub fn role(&self) -> Role {
        self.role
    }

    pub fn is_alive(&self) -> bool {
        self.alive
    }

    pub(crate) fn kill(&mut self) {
        self.alive = false;
    }
}
