//! Unit tests for the lobby: construction and host rules, join/leave paths, the start gate, the id-to-seat mapping, the in-game lockout, and clearing a finished game.

use super::*;
use crate::{DayOutcome, NightOutcome, Phase, Role};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Shorthand for a user id; a free function so it works inside `&mut lobby` calls.
fn u(id: &str) -> UserId {
    UserId(id.to_string())
}

/// A waiting lobby with `n` members named `u0..un`, the first being the host.
fn lobby_with(n: usize) -> Lobby {
    let mut lobby = Lobby::new();
    for i in 0..n {
        let id = format!("u{i}");
        lobby.join(u(&id), id.clone()).expect("join should succeed");
    }
    lobby
}

/// Drive the lobby's game to its end with an agreeing pack and a self-voting town.
fn play_out(lobby: &mut Lobby) {
    let game = lobby.game_mut().expect("game running");
    for _ in 0..(game.players().len() * 2 + 4) {
        match game.phase() {
            Phase::Night => {
                let victim = game.alive().next().expect("someone alive").id();
                let wolves: Vec<_> = game
                    .players()
                    .iter()
                    .filter(|p| p.is_alive() && p.role() == Role::Werewolf)
                    .map(|p| p.id())
                    .collect();
                for wolf in wolves {
                    game.night_action(wolf, victim).expect("night action");
                }
                assert!(matches!(
                    game.resolve_night().expect("night resolves"),
                    NightOutcome::Killed(_)
                ));
            }
            Phase::Day => {
                let living: Vec<_> = game.alive().map(|p| p.id()).collect();
                for voter in &living {
                    game.vote(*voter, *voter).expect("self vote");
                }
                assert_eq!(
                    game.resolve_day().expect("day resolves"),
                    DayOutcome::NoElimination
                );
            }
            Phase::Ended => return,
        }
    }
    panic!("game did not end within the phase cap");
}

// ---------------------------------------------------------------------------
// construction & host
// ---------------------------------------------------------------------------

#[test]
fn a_new_lobby_is_empty_and_waiting_with_no_host() {
    let lobby = Lobby::new();
    assert!(lobby.is_empty());
    assert_eq!(lobby.len(), 0);
    assert_eq!(lobby.state(), LobbyState::Waiting);
    assert!(lobby.host().is_none());
    assert!(lobby.game().is_none());
}

#[test]
fn the_first_member_to_join_is_the_host() {
    let mut lobby = Lobby::new();
    lobby.join(u("a"), "Alice").unwrap();
    lobby.join(u("b"), "Bob").unwrap();

    assert!(lobby.is_host(&u("a")));
    assert!(!lobby.is_host(&u("b")));
    assert_eq!(lobby.host().unwrap().name(), "Alice");
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

#[test]
fn joining_twice_with_the_same_id_is_rejected() {
    let mut lobby = Lobby::new();
    lobby.join(u("a"), "Alice").unwrap();
    assert_eq!(
        lobby.join(u("a"), "Alice again").unwrap_err(),
        LobbyError::AlreadyJoined(u("a"))
    );
    assert_eq!(lobby.len(), 1);
}

#[test]
fn two_members_may_share_a_display_name() {
    let mut lobby = Lobby::new();
    lobby.join(u("a"), "Sam").unwrap();
    lobby.join(u("b"), "Sam").unwrap();
    assert_eq!(lobby.len(), 2);
}

#[test]
fn joining_past_the_cap_is_rejected_as_full() {
    let mut lobby = lobby_with(Lobby::MAX_PLAYERS);
    assert_eq!(
        lobby.join(u("extra"), "Extra").unwrap_err(),
        LobbyError::LobbyFull {
            max: Lobby::MAX_PLAYERS
        }
    );
    assert_eq!(lobby.len(), Lobby::MAX_PLAYERS);
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

#[test]
fn leaving_removes_the_member() {
    let mut lobby = lobby_with(3);
    lobby.leave(&u("u1")).unwrap();
    assert_eq!(lobby.len(), 2);
    assert!(!lobby.contains(&u("u1")));
}

#[test]
fn leaving_when_not_a_member_is_rejected() {
    let mut lobby = lobby_with(3);
    assert_eq!(
        lobby.leave(&u("ghost")).unwrap_err(),
        LobbyError::NotInLobby(u("ghost"))
    );
}

#[test]
fn the_host_leaving_promotes_the_next_longest_waiting_member() {
    let mut lobby = lobby_with(3);
    assert!(lobby.is_host(&u("u0")));
    lobby.leave(&u("u0")).unwrap();
    assert!(lobby.is_host(&u("u1")));
}

#[test]
fn a_non_host_leaving_does_not_change_the_host() {
    let mut lobby = lobby_with(3);
    lobby.leave(&u("u2")).unwrap();
    assert!(lobby.is_host(&u("u0")));
}

#[test]
fn the_last_member_leaving_empties_the_lobby() {
    let mut lobby = lobby_with(1);
    lobby.leave(&u("u0")).unwrap();
    assert!(lobby.is_empty());
    assert!(lobby.host().is_none());
}

#[test]
fn seats_shift_for_members_behind_a_departure() {
    let mut lobby = lobby_with(4);
    assert_eq!(lobby.seat_of(&u("u3")), Some(PlayerId(3)));
    lobby.leave(&u("u1")).unwrap();
    assert_eq!(lobby.seat_of(&u("u0")), Some(PlayerId(0)));
    assert_eq!(lobby.seat_of(&u("u2")), Some(PlayerId(1)));
    assert_eq!(lobby.seat_of(&u("u3")), Some(PlayerId(2)));
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

#[test]
fn can_start_is_false_below_the_minimum_and_true_at_it() {
    let mut lobby = lobby_with(4);
    assert!(!lobby.can_start());
    lobby.join(u("u4"), "u4").unwrap();
    assert!(lobby.can_start());
}

#[test]
fn only_the_host_may_start_the_game() {
    let mut lobby = lobby_with(5);
    assert_eq!(
        lobby.start(&u("u1")).unwrap_err(),
        LobbyError::NotHost(u("u1"))
    );
    assert!(lobby.game().is_none());
}

#[test]
fn starting_below_the_minimum_is_rejected() {
    let mut lobby = lobby_with(4);
    assert_eq!(
        lobby.start(&u("u0")).unwrap_err(),
        LobbyError::TooFewPlayers { got: 4, min: 5 }
    );
}

#[test]
fn a_successful_start_hands_over_a_fresh_engine() {
    let mut lobby = lobby_with(7);
    let game = lobby.start_with_seed(&u("u0"), 1).unwrap();
    assert_eq!(game.players().len(), 7);
    assert_eq!(game.phase(), Phase::Night);
    assert_eq!(game.round(), 1);

    assert_eq!(lobby.state(), LobbyState::InGame);
    assert!(lobby.game().is_some());
}

#[test]
fn starting_a_second_time_is_rejected_while_a_game_runs() {
    let mut lobby = lobby_with(5);
    lobby.start_with_seed(&u("u0"), 1).unwrap();
    assert_eq!(
        lobby.start(&u("u0")).unwrap_err(),
        LobbyError::GameInProgress
    );
}

// ---------------------------------------------------------------------------
// id-to-seat mapping
// ---------------------------------------------------------------------------

#[test]
fn seat_of_follows_join_order_and_member_at_is_its_inverse() {
    let lobby = lobby_with(9);
    for i in 0..9 {
        let id = u(&format!("u{i}"));
        let seat = lobby.seat_of(&id).unwrap();
        assert_eq!(seat, PlayerId(i));
        assert_eq!(lobby.member_at(seat).unwrap().user(), &id);
    }
    assert!(lobby.seat_of(&u("nobody")).is_none());
    assert!(lobby.member_at(PlayerId(9)).is_none());
}

// ---------------------------------------------------------------------------
// in-game lockout
// ---------------------------------------------------------------------------

#[test]
fn joining_and_leaving_are_locked_out_while_a_game_runs() {
    let mut lobby = lobby_with(5);
    lobby.start_with_seed(&u("u0"), 1).unwrap();
    assert_eq!(
        lobby.join(u("late"), "Late").unwrap_err(),
        LobbyError::GameInProgress
    );
    assert_eq!(
        lobby.leave(&u("u1")).unwrap_err(),
        LobbyError::GameInProgress
    );
}

// ---------------------------------------------------------------------------
// end_game
// ---------------------------------------------------------------------------

#[test]
fn end_game_needs_a_running_game() {
    let mut lobby = lobby_with(5);
    assert_eq!(lobby.end_game().unwrap_err(), LobbyError::NoGame);
}

#[test]
fn end_game_is_rejected_while_the_game_is_still_going() {
    let mut lobby = lobby_with(5);
    lobby.start_with_seed(&u("u0"), 1).unwrap();
    assert_eq!(lobby.end_game().unwrap_err(), LobbyError::GameNotOver);
}

#[test]
fn end_game_returns_a_finished_lobby_to_waiting_and_it_can_restart() {
    let mut lobby = lobby_with(6);
    lobby.start_with_seed(&u("u0"), 7).unwrap();
    play_out(&mut lobby);

    lobby.end_game().unwrap();
    assert_eq!(lobby.state(), LobbyState::Waiting);
    assert_eq!(lobby.len(), 6);
    assert!(lobby.start_with_seed(&u("u0"), 8).is_ok());
}
