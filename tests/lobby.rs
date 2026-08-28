//! Integration tests for the lobby: build one over the public API, start a seeded game, and check that the member-to-seat mapping still names the right person as the engine eliminates players.

use wolf::{DayOutcome, Lobby, NightOutcome, Phase, PlayerId, Role, UserId};

/// A waiting lobby with `n` members whose ids and names are both `u0..un`.
fn lobby_with(n: usize) -> Lobby {
    let mut lobby = Lobby::new();
    for i in 0..n {
        let id = format!("u{i}");
        lobby.join(UserId(id.clone()), id).expect("join");
    }
    lobby
}

/// Every member is reachable by seat and the two lookups are exact inverses.
fn assert_mapping_is_consistent(lobby: &Lobby, n: usize) {
    for i in 0..n {
        let id = UserId(format!("u{i}"));
        let seat = lobby.seat_of(&id).expect("member has a seat");
        assert_eq!(seat, PlayerId(i));
        assert_eq!(lobby.member_at(seat).expect("seat is filled").user(), &id);
    }
}

#[test]
fn the_lobby_maps_every_seat_to_the_right_member_through_a_whole_game() {
    for n in Lobby::MIN_PLAYERS..=12 {
        for seed in 0..25 {
            let mut lobby = lobby_with(n);
            let host = UserId("u0".to_string());
            lobby.start_with_seed(&host, seed).expect("start");
            assert_mapping_is_consistent(&lobby, n);

            let game = lobby.game_mut().expect("game running");
            for _ in 0..(n * 2 + 4) {
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
                    Phase::Ended => break,
                }
            }

            assert!(lobby.game().expect("game present").is_over());
            // The roster is frozen during a game, so the mapping is unchanged.
            assert_mapping_is_consistent(&lobby, n);

            lobby.end_game().expect("game is over");
            assert!(lobby.start_with_seed(&host, seed + 1).is_ok());
        }
    }
}
