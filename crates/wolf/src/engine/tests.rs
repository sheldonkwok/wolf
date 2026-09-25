//! Unit tests for the engine: construction & validation, every bad-command rejection path, each win route, and the phase/inspection invariants. Whole unscripted games live in `tests/engine.rs`.

use super::*;
use Role::{Villager as V, Werewolf as W};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Isolate night-action tests with a living roster at Night 1.
fn night_game(roles: &[Role]) -> Engine {
    let mut g = Engine::with_roles(roles).expect("roster should be valid");
    g.phase = Phase::Night;
    g.round = 1;
    g
}

fn day_game(roles: &[Role]) -> Engine {
    let mut g = Engine::with_roles(roles).unwrap();
    g.resolve_opening().unwrap();
    g
}

/// Shorthand for a player id; a free function so it works inside `&mut engine` calls.
fn p(index: usize) -> PlayerId {
    PlayerId(index)
}

fn living_ids(g: &Engine) -> Vec<PlayerId> {
    g.alive().map(|p| p.id()).collect()
}

fn living_wolf_ids(g: &Engine) -> Vec<PlayerId> {
    g.players()
        .iter()
        .filter(|p| p.is_alive() && p.role() == Role::Werewolf)
        .map(|p| p.id())
        .collect()
}

/// Every living werewolf names `target`, then the night is resolved.
fn wolves_kill(g: &mut Engine, target: PlayerId) -> NightOutcome {
    for wolf in living_wolf_ids(g) {
        g.night_action(wolf, target).expect("wolf night action");
    }
    g.resolve_night().expect("night should resolve")
}

/// Every living player votes for `target`, then the day is resolved.
fn town_lynches(g: &mut Engine, target: PlayerId) -> DayOutcome {
    for voter in living_ids(g) {
        g.vote(voter, target).expect("vote");
    }
    g.resolve_day().expect("day should resolve")
}

fn no_ids() -> Vec<PlayerId> {
    Vec::new()
}

#[test]
fn majority_eliminates_before_everyone_votes_and_resets_each_day() {
    for count in [5, 6, 8] {
        let mut roles = vec![V; count];
        roles[0] = W;
        let mut g = day_game(&roles);
        let required = count / 2 + 1;
        assert_eq!(g.majority_required(), required);
        for voter in 0..required - 1 {
            g.vote(p(voter), p(count - 1)).unwrap();
        }
        let before = g.clone();
        assert_eq!(g.resolve_day(), Err(GameError::NoMajority));
        assert_eq!(g, before);
        assert_eq!(g.majority_target(), None);
        g.vote(p(required - 1), p(count - 1)).unwrap();
        assert_eq!(g.majority_target(), Some(p(count - 1)));
        assert!(!g.pending_actors().is_empty());
        assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(count - 1))));
        assert_eq!(g.phase(), Phase::Night);
        assert_eq!(g.round(), 1);
        assert!(g.current_votes().is_empty());
        assert_eq!(g.majority_target(), None);
        wolves_kill(&mut g, p(1));
        assert_eq!(g.phase(), Phase::Day);
        assert_eq!(g.round(), 2);
        assert_eq!(g.majority_required(), (count - 2) / 2 + 1);
        assert_eq!(g.pending_actors(), living_ids(&g));
    }
}

#[test]
fn invalid_votes_leave_state_unchanged() {
    let mut g = night_game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1));
    g.vote(p(2), p(0)).unwrap();
    for (voter, target, error) in [
        (p(99), p(0), GameError::UnknownPlayer(p(99))),
        (p(2), p(99), GameError::UnknownPlayer(p(99))),
        (p(1), p(0), GameError::PlayerNotAlive(p(1))),
        (p(2), p(1), GameError::PlayerNotAlive(p(1))),
    ] {
        let before = g.clone();
        assert_eq!(g.vote(voter, target), Err(error));
        assert_eq!(g, before);
    }
}

// ---------------------------------------------------------------------------
// 1–4: construction & validation
// ---------------------------------------------------------------------------

#[test]
fn rejects_fewer_than_five_players() {
    assert_eq!(
        Engine::new(4).unwrap_err(),
        GameError::TooFewPlayers { got: 4, min: 5 }
    );
    assert!(Engine::new(5).is_ok());
    assert_eq!(
        Engine::with_roles(&[W, V, V, V]).unwrap_err(),
        GameError::TooFewPlayers { got: 4, min: 5 }
    );
}

#[test]
fn werewolf_count_scales_with_player_count() {
    for (players, wolves) in [(5, 1), (6, 2), (7, 2), (8, 2), (9, 3), (11, 3), (12, 4)] {
        let g = Engine::new(players).unwrap();
        let (villagers, actual_wolves) = g.alive_count_by_role();
        assert_eq!(actual_wolves, wolves, "wolves for {players} players");
        assert_eq!(
            villagers,
            players - wolves,
            "villagers for {players} players"
        );
        assert_eq!(g.players().len(), players);
        assert!(g.players().iter().all(|p| p.is_alive()));
        assert_eq!(g.phase(), Phase::Opening);
        assert_eq!(g.round(), 0);
        assert_eq!(g.winner(), None);
        assert!(!g.is_over());
    }
}

#[test]
fn special_village_roles_respect_the_cap_and_are_unique() {
    for (players, expected) in [(5, 2), (8, 2), (12, 2), (13, 2), (14, 3), (16, 3), (100, 3)] {
        for seed in 0..100 {
            let g = Engine::with_seed(players, seed).unwrap();
            let roles: Vec<_> = g.players().iter().map(|p| p.role()).collect();
            let special_count = [Role::Doctor, Role::Seer, Role::Hunter]
                .into_iter()
                .map(|role| {
                    let count = roles.iter().filter(|&&r| r == role).count();
                    assert!(count <= 1);
                    count
                })
                .sum::<usize>();
            assert_eq!(special_count, expected, "players={players}, seed={seed}");
            assert_eq!(
                roles.iter().filter(|&&r| r == V).count(),
                players - players / 3 - expected
            );
            assert!(Engine::with_roles(&roles).is_ok());
        }
    }
}

#[test]
fn capped_deals_randomly_choose_every_special_role_pair() {
    let mut pairs = BTreeSet::new();
    for seed in 0..100 {
        let g = Engine::with_seed(5, seed).unwrap();
        let included = [Role::Doctor, Role::Seer, Role::Hunter]
            .map(|role| g.players().iter().any(|p| p.role() == role));
        pairs.insert(included);
    }
    assert_eq!(
        pairs,
        BTreeSet::from([
            [true, true, false],
            [true, false, true],
            [false, true, true]
        ])
    );
}

#[test]
fn random_deals_are_always_valid_and_do_reshuffle() {
    // Every deal is a legal roster with the right counts.
    let mut deals = Vec::new();
    for _ in 0..200 {
        let g = Engine::new(10).unwrap();
        assert_eq!(g.alive_count_by_role(), (7, 3));
        deals.push(g.players().iter().map(|p| p.role()).collect::<Vec<_>>());
    }

    // A shuffle that always dealt the same order would fail here.
    assert!(deals.iter().any(|d| *d != deals[0]));
}

#[test]
fn with_seed_is_reproducible_and_seed_sensitive() {
    let roles = |seed| {
        Engine::with_seed(9, seed)
            .unwrap()
            .players()
            .iter()
            .map(|p| p.role())
            .collect::<Vec<_>>()
    };

    // Same seed, same deal, every time.
    assert_eq!(roles(1234), roles(1234));

    // Different seeds spread the wolves around rather than always dealing the same order.
    let deals = (0..50).map(roles).collect::<Vec<_>>();
    assert!(deals.iter().any(|d| *d != deals[0]));

    // Every seeded deal is still a legal, correctly-sized roster.
    for seed in 0..50 {
        let g = Engine::with_seed(9, seed).unwrap();
        assert_eq!(g.alive_count_by_role(), (6, 3));
        assert_eq!(g.phase(), Phase::Opening);
        assert_eq!(g.round(), 0);
    }
}

#[test]
fn with_roles_rejects_unstartable_rosters() {
    assert_eq!(
        Engine::with_roles(&[V, V, V, V]).unwrap_err(),
        GameError::TooFewPlayers { got: 4, min: 5 }
    );
    assert!(matches!(
        Engine::with_roles(&[V, V, V, V, V]).unwrap_err(),
        GameError::InvalidRoster(_)
    ));
    // Three wolves vs two villagers is a werewolf win before the game starts.
    assert!(matches!(
        Engine::with_roles(&[W, W, W, V, V]).unwrap_err(),
        GameError::InvalidRoster(_)
    ));
}

// ---------------------------------------------------------------------------
// 5–13: invalid commands (each also checks state is untouched)
// ---------------------------------------------------------------------------

#[test]
fn villager_cannot_take_the_night_action() {
    let mut g = night_game(&[W, V, V, V, V]);
    assert_eq!(
        g.night_action(p(1), p(2)).unwrap_err(),
        GameError::NotAWerewolf(p(1))
    );
    assert_eq!(g.pending_actors(), vec![p(0)]);
}

#[test]
fn out_of_range_ids_are_rejected() {
    let mut g = night_game(&[W, V, V, V, V]);
    assert_eq!(
        g.night_action(p(9), p(1)).unwrap_err(),
        GameError::UnknownPlayer(p(9))
    );
    assert_eq!(
        g.night_action(p(0), p(9)).unwrap_err(),
        GameError::UnknownPlayer(p(9))
    );
    assert_eq!(g.role_of(p(9)).unwrap_err(), GameError::UnknownPlayer(p(9)));
    assert!(!g.is_alive(p(9)));
}

#[test]
fn dead_players_cannot_act_or_be_targeted() {
    let mut g = night_game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // night 1 eliminates V2
    town_lynches(&mut g, p(1)); // day 2 lynches W1
    assert_eq!(g.phase(), Phase::Night);

    // A dead wolf cannot act...
    assert_eq!(
        g.night_action(p(1), p(3)).unwrap_err(),
        GameError::PlayerNotAlive(p(1))
    );
    // ...and a dead villager cannot be targeted.
    assert_eq!(
        g.night_action(p(0), p(2)).unwrap_err(),
        GameError::PlayerNotAlive(p(2))
    );
}

#[test]
fn a_day_vote_can_change_without_counting_twice() {
    let mut g = day_game(&[W, V, V, V, V]);
    g.vote(p(1), p(0)).unwrap();
    g.vote(p(1), p(0)).unwrap();
    assert_eq!(g.current_votes().len(), 1);
    g.vote(p(1), p(3)).unwrap();
    assert_eq!(g.current_votes(), [(p(1), p(3))].into_iter().collect());
    assert_eq!(g.majority_target(), None);
}

#[test]
fn a_wolf_may_overwrite_their_night_pick() {
    let mut g = night_game(&[W, W, V, V, V, V]);
    g.night_action(p(0), p(2)).unwrap();
    g.night_action(p(1), p(3)).unwrap();
    // P0 changes their mind to match P1; the pack now agrees.
    g.night_action(p(0), p(3)).unwrap();
    assert_eq!(
        g.current_night_picks(),
        [(p(0), p(3)), (p(1), p(3))].into_iter().collect()
    );
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(3)));
}

#[test]
fn commands_are_rejected_in_the_wrong_phase() {
    let mut g = night_game(&[W, V, V, V, V]);
    // Night: voting and resolving the day are both illegal.
    assert_eq!(
        g.vote(p(1), p(0)).unwrap_err(),
        GameError::WrongPhase {
            expected: Phase::Day,
            actual: Phase::Night,
        }
    );
    assert_eq!(
        g.resolve_day().unwrap_err(),
        GameError::WrongPhase {
            expected: Phase::Day,
            actual: Phase::Night,
        }
    );

    wolves_kill(&mut g, p(1));
    assert_eq!(g.phase(), Phase::Day);

    // Day: the night action and resolving the night are both illegal.
    assert_eq!(
        g.night_action(p(0), p(2)).unwrap_err(),
        GameError::WrongPhase {
            expected: Phase::Night,
            actual: Phase::Day,
        }
    );
    assert_eq!(
        g.resolve_night().unwrap_err(),
        GameError::WrongPhase {
            expected: Phase::Night,
            actual: Phase::Day,
        }
    );
}

#[test]
fn resolve_night_waits_for_every_wolf() {
    let mut g = night_game(&[W, W, V, V, V, V]);
    g.night_action(p(0), p(2)).unwrap();
    assert_eq!(
        g.resolve_night().unwrap_err(),
        GameError::ActionsIncomplete {
            waiting_on: vec![p(1)],
        }
    );
    assert_eq!(g.pending_actors(), vec![p(1)]);
    assert_eq!(g.phase(), Phase::Night);
}

#[test]
fn a_split_pack_repicks_instead_of_deadlocking() {
    let mut g = night_game(&[W, W, V, V, V, V]);
    g.night_action(p(0), p(2)).unwrap();
    g.night_action(p(1), p(3)).unwrap();
    assert_eq!(
        g.resolve_night().unwrap(),
        NightOutcome::NoConsensus {
            targets: vec![p(2), p(3)],
        }
    );
    // Nobody died, the night stands, and both wolves owe a fresh pick.
    assert_eq!(g.phase(), Phase::Night);
    assert_eq!(g.round(), 1);
    assert_eq!(living_ids(&g), vec![p(0), p(1), p(2), p(3), p(4), p(5)]);
    assert_eq!(g.pending_actors(), vec![p(0), p(1)]);
    assert!(g.current_night_picks().is_empty());

    // They agree the second time around and the kill lands.
    g.night_action(p(0), p(3)).unwrap();
    g.night_action(p(1), p(3)).unwrap();
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(3)));
    assert_eq!(g.phase(), Phase::Day);
}

#[test]
fn resolve_night_still_waits_on_a_silent_wolf_before_judging_the_pack() {
    let mut g = night_game(&[W, W, V, V, V, V]);
    g.night_action(p(0), p(2)).unwrap();
    // P1 has not picked at all: that is incomplete, not a split.
    assert_eq!(
        g.resolve_night().unwrap_err(),
        GameError::ActionsIncomplete {
            waiting_on: vec![p(1)],
        }
    );
}

#[test]
fn a_lone_wolf_never_reports_no_consensus() {
    let mut g = night_game(&[W, V, V, V, V]);
    g.night_action(p(0), p(1)).unwrap();
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(1)));
}

#[test]
fn resolve_day_requires_more_than_half_the_living_players() {
    let mut g = night_game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // living: P0, P2, P3, P4
    g.vote(p(0), p(3)).unwrap();
    g.vote(p(2), p(3)).unwrap();
    assert_eq!(g.resolve_day().unwrap_err(), GameError::NoMajority);
}

#[test]
fn no_commands_are_accepted_after_the_game_ends() {
    let mut g = night_game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // 3 villagers, 1 wolf
    town_lynches(&mut g, p(2)); // mislynch -> 2 villagers, 1 wolf
    wolves_kill(&mut g, p(3)); // 1 vs 1 -> werewolves win
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));

    assert_eq!(g.night_action(p(0), p(4)).unwrap_err(), GameError::GameOver);
    assert_eq!(g.resolve_night().unwrap_err(), GameError::GameOver);
    assert_eq!(g.vote(p(4), p(0)).unwrap_err(), GameError::GameOver);
    assert_eq!(g.resolve_day().unwrap_err(), GameError::GameOver);
    assert_eq!(g.resolve_opening().unwrap_err(), GameError::GameOver);
    assert_eq!(g.pending_actors(), no_ids());
}

// ---------------------------------------------------------------------------
// 14–18: villagers win, via several distinct routes
// ---------------------------------------------------------------------------

#[test]
fn villagers_win_by_lynching_the_lone_wolf_on_day_one() {
    let mut g = day_game(&[W, V, V, V, V]);
    assert_eq!(g.phase(), Phase::Day);

    assert_eq!(town_lynches(&mut g, p(0)), DayOutcome::Eliminated(p(0)));
    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.round(), 1);
    assert_eq!(g.alive_count_by_role(), (4, 0));
}

#[test]
fn villagers_win_by_lynching_both_wolves_on_successive_days() {
    let mut g = night_game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // night 1
    town_lynches(&mut g, p(0)); // day 2: first wolf
    assert_eq!(g.winner(), None);

    wolves_kill(&mut g, p(3)); // night 2
    town_lynches(&mut g, p(1)); // day 3: last wolf
    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(g.round(), 3);
}

#[test]
fn villagers_win_on_the_last_possible_day() {
    let mut g = day_game(&[W, V, V, V, V]);
    town_lynches(&mut g, p(1));
    wolves_kill(&mut g, p(2));
    assert_eq!(g.alive_count_by_role(), (2, 1));
    town_lynches(&mut g, p(0));
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn villagers_win_when_the_pack_devours_its_own() {
    let mut g = night_game(&[W, W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // both wolves agree to kill wolf P1
    assert_eq!(g.alive_count_by_role(), (4, 1));

    town_lynches(&mut g, p(0)); // town finishes the last wolf
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn the_last_surviving_wolf_cannot_kill_itself() {
    let mut g = night_game(&[W, W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // wolves kill wolf P2
    town_lynches(&mut g, p(1)); // town lynches wolf P1
    assert_eq!(
        g.night_action(p(0), p(0)),
        Err(GameError::LastWolfCannotTargetSelf)
    );
    assert_eq!(g.winner(), None);
    assert_eq!(g.alive_count_by_role(), (6, 1));
    assert_eq!(g.pending_actors(), vec![p(0)]);
    assert!(g.current_night_picks().is_empty());
    assert_eq!(
        g.resolve_night(),
        Err(GameError::ActionsIncomplete {
            waiting_on: vec![p(0)]
        })
    );
    assert_eq!(wolves_kill(&mut g, p(3)), NightOutcome::Killed(p(3)));
}

#[test]
fn a_lone_wolf_cannot_replace_a_valid_pick_with_itself() {
    let mut g = night_game(&[W, V, V, V, V]);
    g.night_action(p(0), p(1)).unwrap();
    assert_eq!(
        g.night_action(p(0), p(0)),
        Err(GameError::LastWolfCannotTargetSelf)
    );
    assert_eq!(
        g.current_night_picks(),
        [(p(0), p(1))].into_iter().collect()
    );
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(1)));
}

// ---------------------------------------------------------------------------
// 19–23: werewolves win, via several distinct routes
// ---------------------------------------------------------------------------

#[test]
fn werewolves_win_with_repeated_mislynches() {
    let mut g = day_game(&[W, V, V, V, V]);
    town_lynches(&mut g, p(1));
    wolves_kill(&mut g, p(2));
    assert_eq!(town_lynches(&mut g, p(3)), DayOutcome::Eliminated(p(3)));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_after_a_single_mislynch() {
    let mut g = night_game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // 3 villagers, 1 wolf
    town_lynches(&mut g, p(2)); // mislynch -> 2 villagers, 1 wolf
    wolves_kill(&mut g, p(3)); // 1 vs 1

    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_at_day_resolution_when_a_lynch_reaches_parity() {
    let mut g = night_game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // 5 villagers, 2 wolves
    town_lynches(&mut g, p(3)); // mislynch -> 4 villagers, 2 wolves
    wolves_kill(&mut g, p(4)); // 3 villagers, 2 wolves
    let out = town_lynches(&mut g, p(5)); // mislynch -> 2 vs 2

    assert_eq!(out, DayOutcome::Eliminated(p(5)));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_at_night_after_an_opening_mislynch() {
    let mut g = day_game(&[W, W, V, V, V, V, V, V]);
    town_lynches(&mut g, p(2));
    wolves_kill(&mut g, p(3));
    town_lynches(&mut g, p(4));
    assert_eq!(wolves_kill(&mut g, p(5)), NightOutcome::Killed(p(5)));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_a_twelve_player_game() {
    let mut g = day_game(&[W, W, W, V, V, V, V, V, V, V, V, V]);
    for target in [3, 5, 7] {
        town_lynches(&mut g, p(target));
        wolves_kill(&mut g, p(target + 1));
    }
    assert_eq!(g.winner(), Some(Winner::Werewolves));
    assert_eq!(g.alive_count_by_role(), (3, 3));
}

// ---------------------------------------------------------------------------
// 24–28: phase & inspection invariants
// ---------------------------------------------------------------------------

#[test]
fn a_complete_ballot_eliminates_its_unique_leader_without_a_majority() {
    let mut g = day_game(&[W, V, V, V, V, V, V, V]);
    for (voter, target) in [3, 3, 3, 1, 1, 2, 2].into_iter().enumerate() {
        g.vote(p(voter), p(target)).unwrap();
    }
    let before = g.clone();
    assert_eq!(g.resolve_day(), Err(GameError::NoMajority));
    assert_eq!(g, before);
    g.vote(p(7), p(4)).unwrap();
    assert_eq!(g.majority_target(), None);
    assert!(g.pending_actors().is_empty());
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(3))));
    assert_eq!(g.phase(), Phase::Night);
    assert_eq!(g.round(), 1);
    assert!(!g.is_alive(p(3)));
    assert!(g.current_votes().is_empty());
}

#[test]
fn tied_top_votes_eliminate_nobody_and_reset_the_ballot() {
    for votes in [
        [0, 0, 0, 0, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1, 2, 3],
        [0, 1, 2, 3, 4, 5, 6, 7],
    ] {
        let mut g = day_game(&[W, Role::Hunter, V, V, V, V, V, V]);
        for (voter, target) in votes.into_iter().enumerate() {
            g.vote(p(voter), p(target)).unwrap();
        }
        assert_eq!(g.majority_target(), None);
        assert_eq!(g.resolve_day(), Ok(DayOutcome::Tied));
        assert_eq!(g.phase(), Phase::Night);
        assert_eq!(g.round(), 1);
        assert_eq!(g.alive().count(), 8);
        assert_eq!(g.winner(), None);
        assert!(g.current_votes().is_empty());
        assert_eq!(g.pending_actors(), vec![p(0)]);
        assert!(matches!(
            g.vote(p(0), p(1)),
            Err(GameError::WrongPhase { .. })
        ));
        wolves_kill(&mut g, p(7));
        assert_eq!(g.round(), 2);
        assert_eq!(g.pending_actors(), living_ids(&g));
        for (voter, target) in [1, 1, 1, 2, 2, 3, 3].into_iter().enumerate() {
            g.vote(p(voter), p(target)).unwrap();
        }
        assert!(g.pending_actors().is_empty());
        assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(1))));
        assert_eq!(g.round(), 2);
    }
}

#[test]
fn changed_votes_count_once_when_the_last_player_completes_the_ballot() {
    let mut g = day_game(&[W, V, V, V, V]);
    for (voter, target) in [0, 1, 2, 3].into_iter().enumerate() {
        g.vote(p(voter), p(target)).unwrap();
    }
    g.vote(p(0), p(1)).unwrap();
    g.vote(p(0), p(1)).unwrap();
    assert_eq!(g.current_votes().len(), 4);
    assert_eq!(g.resolve_day(), Err(GameError::NoMajority));
    g.vote(p(4), p(4)).unwrap();
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(1))));
}

#[test]
fn plurality_elimination_keeps_hunter_and_victory_rules() {
    for role in [Role::Hunter, W] {
        let mut g = day_game(&[W, V, V, role, V, V, V, V]);
        for (voter, target) in [3, 3, 3, 1, 1, 2, 2, 4].into_iter().enumerate() {
            g.vote(p(voter), p(target)).unwrap();
        }
        assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(3))));
        assert!(g.current_votes().is_empty());
        if role == Role::Hunter {
            assert_eq!(g.phase(), Phase::Hunter);
            assert_eq!(g.pending_actors(), vec![p(3)]);
            g.hunter_action(p(3), p(0)).unwrap();
            assert_eq!(g.winner(), Some(Winner::Villagers));
        } else {
            assert_eq!(g.phase(), Phase::Night);
            assert_eq!(g.winner(), None);
        }
    }
    let mut g = day_game(&[W, V, V, V, V]);
    for (voter, target) in [0, 0, 1, 2, 3].into_iter().enumerate() {
        g.vote(p(voter), p(target)).unwrap();
    }
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(0))));
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn pending_actors_tracks_who_still_owes_an_action() {
    let mut g = night_game(&[W, W, V, V, V, V, V, V]);
    assert_eq!(g.pending_actors(), vec![p(0), p(1)]);
    g.night_action(p(0), p(2)).unwrap();
    assert_eq!(g.pending_actors(), vec![p(1)]);
    g.night_action(p(1), p(2)).unwrap();
    assert_eq!(g.pending_actors(), no_ids());
    g.resolve_night().unwrap();

    // In the day phase every living player is pending until they vote.
    assert_eq!(g.pending_actors(), living_ids(&g));

    // After a wolf is lynched, the surviving lone wolf's single pick is enough.
    town_lynches(&mut g, p(1));
    assert_eq!(g.pending_actors(), vec![p(0)]);
    g.night_action(p(0), p(3)).unwrap();
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(3)));
}

#[test]
fn opening_day_accepts_votes_and_rejects_night_actions() {
    let mut g = day_game(&[W, V, V, V, V, V]);
    let before = g.clone();
    assert!(matches!(
        g.night_action(p(0), p(1)),
        Err(GameError::WrongPhase { .. })
    ));
    assert!(matches!(
        g.resolve_night(),
        Err(GameError::WrongPhase { .. })
    ));
    assert_eq!(g, before);
    g.vote(p(0), p(1)).unwrap();
    assert_eq!(g.current_votes(), [(p(0), p(1))].into_iter().collect());
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.round(), 1);
}

#[test]
fn alive_counts_follow_every_kill_and_lynch() {
    let mut g = night_game(&[W, W, V, V, V, V, V, V]);
    assert_eq!(g.alive_count_by_role(), (6, 2));
    wolves_kill(&mut g, p(2));
    assert_eq!(g.alive_count_by_role(), (5, 2));
    town_lynches(&mut g, p(0));
    assert_eq!(g.alive_count_by_role(), (5, 1));
    wolves_kill(&mut g, p(3));
    assert_eq!(g.alive_count_by_role(), (4, 1));
    town_lynches(&mut g, p(1));
    assert_eq!(g.alive_count_by_role(), (4, 0));
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn identical_rosters_and_commands_produce_identical_games() {
    let roles = [W, V, W, V, V, V, V, V]; // wolves are P0 and P2

    fn play(g: &mut Engine) {
        g.night_action(p(0), p(3)).unwrap();
        g.night_action(p(2), p(3)).unwrap();
        g.resolve_night().unwrap();
        for voter in [0, 1, 2, 4, 5, 6, 7] {
            g.vote(p(voter), p(0)).unwrap();
        }
        g.resolve_day().unwrap();
        g.night_action(p(2), p(4)).unwrap();
        g.resolve_night().unwrap();
        for voter in [1, 2, 5, 6, 7] {
            g.vote(p(voter), p(2)).unwrap();
        }
        g.resolve_day().unwrap();
    }

    let mut a = night_game(&roles);
    let mut b = night_game(&roles);
    play(&mut a);
    play(&mut b);

    assert_eq!(a, b);
    assert_eq!(a.winner(), Some(Winner::Villagers));
}

#[test]
fn large_deals_include_all_special_roles_on_the_village_team() {
    for count in 14..=20 {
        for seed in 0..50 {
            let g = Engine::with_seed(count, seed).unwrap();
            for role in [Role::Doctor, Role::Seer, Role::Hunter] {
                assert_eq!(g.players().iter().filter(|p| p.role() == role).count(), 1);
            }
            assert_eq!(g.alive_count_by_role(), (count - count / 3, count / 3));
        }
    }
    for role in [Role::Doctor, Role::Seer] {
        assert!(matches!(
            Engine::with_roles(&[W, role, role, V, V]),
            Err(GameError::InvalidRoster(_))
        ));
    }
}

#[test]
fn doctor_can_save_any_role_including_self_and_protection_expires() {
    for target in 0..5 {
        let mut g = night_game(&[W, Role::Doctor, Role::Seer, V, V, W]);
        g.night_action(p(0), p(target)).unwrap();
        g.night_action(p(5), p(target)).unwrap();
        let before = g.clone();
        assert_eq!(
            g.resolve_night(),
            Err(GameError::ActionsIncomplete {
                waiting_on: vec![p(1), p(2)]
            })
        );
        assert_eq!(g, before);
        g.doctor_action(p(1), p(target)).unwrap();
        g.seer_action(p(2), p(0)).unwrap();
        assert!(g.pending_actors().is_empty());
        assert_eq!(g.resolve_night(), Ok(NightOutcome::Saved(p(target))));
        assert_eq!(g.alive().count(), 6);
        assert!(g.current_doctor_picks().is_empty());
        assert_eq!(g.round(), 2);
        town_lynches(&mut g, p(4));
        g.doctor_action(p(1), p(0)).unwrap();
        g.seer_action(p(2), p(1)).unwrap();
        assert_eq!(wolves_kill(&mut g, p(3)), NightOutcome::Killed(p(3)));
    }
}

#[test]
fn opening_inspection_waits_for_resolution_then_starts_day_one_without_eliminations() {
    for (target, is_werewolf) in [(p(0), true), (p(1), false), (p(2), false)] {
        let mut g = Engine::with_roles(&[W, Role::Doctor, Role::Seer, V, V, V]).unwrap();
        assert_eq!(g.phase(), Phase::Opening);
        assert_eq!(g.round(), 0);
        assert_eq!(g.pending_actors(), vec![p(2)]);
        let result = g.seer_action(p(2), target).unwrap();
        assert_eq!(
            result,
            Inspection {
                seer: p(2),
                target,
                round: 0,
                is_werewolf
            }
        );
        assert_eq!(g.phase(), Phase::Opening);
        assert_eq!(g.round(), 0);
        assert!(g.pending_actors().is_empty());
        let before = g.clone();
        assert_eq!(
            g.seer_action(p(2), p(0)),
            Err(GameError::AlreadyActed(p(2)))
        );
        assert!(matches!(
            g.vote(p(0), p(1)),
            Err(GameError::WrongPhase { .. })
        ));
        assert_eq!(g, before);
        g.resolve_opening().unwrap();
        assert_eq!(g.phase(), Phase::Day);
        assert_eq!(g.round(), 1);
        assert_eq!(g.alive().count(), 6);
        assert_eq!(g.pending_actors(), living_ids(&g));
        assert_eq!(g.inspections(), &[result]);
        assert!(g.current_votes().is_empty());
        assert!(g.current_night_picks().is_empty());
        assert!(g.current_doctor_picks().is_empty());
        assert!(matches!(
            g.seer_action(p(2), p(0)),
            Err(GameError::WrongPhase { .. })
        ));
        town_lynches(&mut g, p(5));
        assert_eq!(g.round(), 1);
        let next = g.seer_action(p(2), p(0)).unwrap();
        assert_eq!(next.round, 1);
        g.night_action(p(0), p(1)).unwrap();
        g.doctor_action(p(1), p(1)).unwrap();
        assert_eq!(g.resolve_night(), Ok(NightOutcome::Saved(p(1))));
        assert_eq!(g.phase(), Phase::Day);
        assert_eq!(g.round(), 2);
        assert_eq!(g.inspections(), &[result, next]);
    }
}

#[test]
fn opening_rejects_other_actions_and_invalid_inspections_without_mutation() {
    let mut g = Engine::with_roles(&[W, Role::Doctor, Role::Seer, V, V]).unwrap();
    let before = g.clone();
    for result in [
        g.vote(p(0), p(3)),
        g.night_action(p(0), p(3)),
        g.doctor_action(p(1), p(3)),
        g.hunter_action(p(3), p(0)),
    ] {
        assert!(matches!(
            result,
            Err(GameError::WrongPhase {
                actual: Phase::Opening,
                ..
            })
        ));
    }
    assert!(matches!(g.resolve_day(), Err(GameError::WrongPhase { .. })));
    assert!(matches!(
        g.resolve_night(),
        Err(GameError::WrongPhase { .. })
    ));
    for (actor, target, error) in [
        (p(0), p(3), GameError::NotASeer(p(0))),
        (p(99), p(3), GameError::UnknownPlayer(p(99))),
        (p(2), p(99), GameError::UnknownPlayer(p(99))),
    ] {
        assert_eq!(g.seer_action(actor, target), Err(error));
        assert_eq!(g, before);
    }
}

#[test]
fn openings_resolve_with_no_seer_or_an_unsubmitted_inspection() {
    for role in [Role::Hunter, Role::Seer] {
        let mut g = Engine::with_roles(&[W, Role::Doctor, role, V, V]).unwrap();
        assert_eq!(g.phase(), Phase::Opening);
        assert_eq!(g.round(), 0);
        assert_eq!(
            g.pending_actors(),
            if role == Role::Seer {
                vec![p(2)]
            } else {
                vec![]
            }
        );
        g.resolve_opening().unwrap();
        assert_eq!(g.phase(), Phase::Day);
        assert_eq!(g.round(), 1);
        assert_eq!(g.alive().count(), 5);
        assert_eq!(g.pending_actors(), living_ids(&g));
        assert!(g.inspections().is_empty());
        let before = g.clone();
        assert!(matches!(
            g.resolve_opening(),
            Err(GameError::WrongPhase { .. })
        ));
        assert!(matches!(
            g.seer_action(p(2), p(0)),
            Err(GameError::WrongPhase { .. })
        ));
        assert_eq!(g, before);
        town_lynches(&mut g, p(4));
        assert!(matches!(
            g.resolve_opening(),
            Err(GameError::WrongPhase { .. })
        ));
        if role == Role::Seer {
            assert_eq!(g.seer_action(p(2), p(0)).unwrap().round, 1);
        }
    }
}

#[test]
fn seer_learns_alignment_once_per_night_and_history_survives_resolution() {
    let mut g = night_game(&[W, Role::Doctor, Role::Seer, V, V]);
    let first = g.seer_action(p(2), p(0)).unwrap();
    assert!(first.is_werewolf);
    assert_eq!(first.round, 1);
    let before = g.clone();
    assert_eq!(
        g.seer_action(p(2), p(1)),
        Err(GameError::AlreadyActed(p(2)))
    );
    assert_eq!(g, before);
    g.doctor_action(p(1), p(1)).unwrap();
    assert_eq!(wolves_kill(&mut g, p(1)), NightOutcome::Saved(p(1)));
    town_lynches(&mut g, p(4));
    let second = g.seer_action(p(2), p(1)).unwrap();
    assert!(!second.is_werewolf);
    assert_eq!(second.round, 2);
    assert_eq!(g.inspections(), &[first, second]);
}

#[test]
fn special_role_rejections_do_not_change_state() {
    let mut g = night_game(&[W, Role::Doctor, Role::Seer, V, V, V]);
    let before = g.clone();
    assert_eq!(
        g.doctor_action(p(3), p(0)),
        Err(GameError::NotADoctor(p(3)))
    );
    assert_eq!(g.seer_action(p(1), p(0)), Err(GameError::NotASeer(p(1))));
    assert_eq!(
        g.doctor_action(p(99), p(0)),
        Err(GameError::UnknownPlayer(p(99)))
    );
    assert_eq!(
        g.seer_action(p(99), p(0)),
        Err(GameError::UnknownPlayer(p(99)))
    );
    assert_eq!(
        g.doctor_action(p(1), p(99)),
        Err(GameError::UnknownPlayer(p(99)))
    );
    assert_eq!(
        g.seer_action(p(2), p(99)),
        Err(GameError::UnknownPlayer(p(99)))
    );
    assert_eq!(g, before);
    g.doctor_action(p(1), p(1)).unwrap();
    let before = g.clone();
    assert_eq!(
        g.doctor_action(p(1), p(0)),
        Err(GameError::AlreadyActed(p(1)))
    );
    assert_eq!(g, before);
    g.seer_action(p(2), p(0)).unwrap();
    wolves_kill(&mut g, p(3));
    let before = g.clone();
    assert!(matches!(
        g.doctor_action(p(1), p(1)),
        Err(GameError::WrongPhase { .. })
    ));
    assert!(matches!(
        g.seer_action(p(2), p(0)),
        Err(GameError::WrongPhase { .. })
    ));
    assert_eq!(g, before);
    town_lynches(&mut g, p(4));
    let before = g.clone();
    assert_eq!(
        g.doctor_action(p(1), p(3)),
        Err(GameError::PlayerNotAlive(p(3)))
    );
    assert_eq!(
        g.seer_action(p(2), p(3)),
        Err(GameError::PlayerNotAlive(p(3)))
    );
    assert_eq!(g, before);
}

#[test]
fn a_split_pack_preserves_special_actions_and_seer_cannot_inspect_again() {
    let mut g = night_game(&[W, W, Role::Doctor, Role::Seer, V, V, V]);
    g.doctor_action(p(2), p(4)).unwrap();
    g.seer_action(p(3), p(0)).unwrap();
    g.night_action(p(0), p(4)).unwrap();
    g.night_action(p(1), p(5)).unwrap();
    assert!(matches!(
        g.resolve_night(),
        Ok(NightOutcome::NoConsensus { .. })
    ));
    assert_eq!(g.pending_actors(), vec![p(0), p(1)]);
    assert_eq!(
        g.seer_action(p(3), p(1)),
        Err(GameError::AlreadyActed(p(3)))
    );
    assert_eq!(wolves_kill(&mut g, p(4)), NightOutcome::Saved(p(4)));
}

#[test]
fn killed_special_roles_do_not_block_future_nights_and_still_act_on_their_last_night() {
    for victim in [1, 2] {
        let mut g = night_game(&[W, Role::Doctor, Role::Seer, V, V, V]);
        g.doctor_action(p(1), p(3)).unwrap();
        g.seer_action(p(2), p(0)).unwrap();
        assert_eq!(
            wolves_kill(&mut g, p(victim)),
            NightOutcome::Killed(p(victim))
        );
        assert_eq!(g.inspections().len(), 1);
        town_lynches(&mut g, p(4));
        assert!(!g.pending_actors().contains(&p(victim)));
        let before = g.clone();
        if victim == 1 {
            assert_eq!(
                g.doctor_action(p(1), p(0)),
                Err(GameError::PlayerNotAlive(p(1)))
            );
        } else {
            assert_eq!(
                g.seer_action(p(2), p(0)),
                Err(GameError::PlayerNotAlive(p(2)))
            );
        }
        assert_eq!(g, before);
    }
}

#[test]
fn special_roles_count_for_parity_and_cannot_act_after_game_over() {
    let mut g = night_game(&[W, Role::Doctor, Role::Seer, V, V]);
    g.doctor_action(p(1), p(1)).unwrap();
    g.seer_action(p(2), p(0)).unwrap();
    wolves_kill(&mut g, p(3));
    town_lynches(&mut g, p(4));
    assert_eq!(g.alive_count_by_role(), (2, 1));
    assert!(!g.is_over());
    g.doctor_action(p(1), p(1)).unwrap();
    g.seer_action(p(2), p(0)).unwrap();
    wolves_kill(&mut g, p(2));
    assert_eq!(g.winner(), Some(Winner::Werewolves));
    let before = g.clone();
    assert_eq!(g.doctor_action(p(1), p(1)), Err(GameError::GameOver));
    assert_eq!(g.seer_action(p(2), p(0)), Err(GameError::GameOver));
    assert_eq!(g, before);
}
