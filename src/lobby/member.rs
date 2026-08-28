use std::fmt;

/// An opaque platform user handle, such as a Slack or Discord user id; this is the key that identifies a member.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(pub String);

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<&str> for UserId {
    fn from(s: &str) -> Self {
        UserId(s.to_string())
    }
}

impl From<String> for UserId {
    fn from(s: String) -> Self {
        UserId(s)
    }
}

/// One person in a [`Lobby`](crate::Lobby): the id is their identity, the name is a cosmetic label that may repeat or change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    user: UserId,
    name: String,
}

impl Member {
    pub(crate) fn new(user: UserId, name: String) -> Self {
        Member { user, name }
    }

    /// The member's opaque platform id.
    pub fn user(&self) -> &UserId {
        &self.user
    }

    /// The member's display name.
    pub fn name(&self) -> &str {
        &self.name
    }
}
