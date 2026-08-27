//! Integration tests that drive whole games to each win condition, plus phase/inspection invariants and every bad-command rejection path.

use wolf::Role::{Villager as V, Werewolf as W};
use wolf::{DayOutcome, Engine, GameError, NightOutcome, Phase, PlayerId, Role, Winner};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Build a game from an exact roster, panicking if the roster is invalid.
fn game(roles: &[Role]) -> Engine {
    Engine::with_roles(roles).expect("roster should be valid")
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

/// Every living player votes for themselves, guaranteeing a tie for the lead.
fn town_ties(g: &mut Engine) -> DayOutcome {
    for voter in living_ids(g) {
        g.vote(voter, voter).expect("self vote");
    }
    g.resolve_day().expect("day should resolve")
}

fn no_ids() -> Vec<PlayerId> {
    Vec::new()
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
    for (players, wolves) in [(5, 1), (7, 1), (8, 2), (11, 2), (12, 3)] {
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
        assert_eq!(g.phase(), Phase::Night);
        assert_eq!(g.round(), 1);
        assert_eq!(g.winner(), None);
        assert!(!g.is_over());
    }
}

#[test]
fn random_deals_are_always_valid_and_do_reshuffle() {
    // Every deal is a legal roster with the right counts.
    let mut deals = Vec::new();
    for _ in 0..200 {
        let g = Engine::new(10).unwrap();
        assert_eq!(g.alive_count_by_role(), (8, 2));
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
        assert_eq!(g.alive_count_by_role(), (7, 2));
        assert_eq!(g.phase(), Phase::Night);
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
    let mut g = game(&[W, V, V, V, V]);
    assert_eq!(
        g.night_action(p(1), p(2)).unwrap_err(),
        GameError::NotAWerewolf(p(1))
    );
    assert_eq!(g.pending_actors(), vec![p(0)]);
}

#[test]
fn out_of_range_ids_are_rejected() {
    let mut g = game(&[W, V, V, V, V]);
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
    let mut g = game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // night 1 eliminates V2
    town_lynches(&mut g, p(1)); // day 1 lynches W1
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
fn a_day_vote_cannot_be_changed_once_cast() {
    let mut g = game(&[W, W, V, V, V, V]);
    wolves_kill(&mut g, p(2));

    g.vote(p(1), p(0)).unwrap();
    assert_eq!(
        g.vote(p(1), p(3)).unwrap_err(),
        GameError::AlreadyActed(p(1))
    );
}

#[test]
fn a_wolf_may_overwrite_their_night_pick() {
    let mut g = game(&[W, W, V, V, V, V]);
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
    let mut g = game(&[W, V, V, V, V]);
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
    let mut g = game(&[W, W, V, V, V, V]);
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
    let mut g = game(&[W, W, V, V, V, V]);
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
    let mut g = game(&[W, W, V, V, V, V]);
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
    let mut g = game(&[W, V, V, V, V]);
    g.night_action(p(0), p(1)).unwrap();
    assert_eq!(g.resolve_night().unwrap(), NightOutcome::Killed(p(1)));
}

#[test]
fn resolve_day_waits_for_every_living_voter() {
    let mut g = game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // living: P0, P2, P3, P4
    g.vote(p(0), p(3)).unwrap();
    g.vote(p(2), p(3)).unwrap();
    assert_eq!(
        g.resolve_day().unwrap_err(),
        GameError::ActionsIncomplete {
            waiting_on: vec![p(3), p(4)],
        }
    );
}

#[test]
fn no_commands_are_accepted_after_the_game_ends() {
    let mut g = game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // 3 villagers, 1 wolf
    town_lynches(&mut g, p(2)); // mislynch -> 2 villagers, 1 wolf
    wolves_kill(&mut g, p(3)); // 1 vs 1 -> werewolves win
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));

    assert_eq!(g.night_action(p(0), p(4)).unwrap_err(), GameError::GameOver);
    assert_eq!(g.resolve_night().unwrap_err(), GameError::GameOver);
    assert_eq!(g.vote(p(4), p(0)).unwrap_err(), GameError::GameOver);
    assert_eq!(g.resolve_day().unwrap_err(), GameError::GameOver);
    assert_eq!(g.pending_actors(), no_ids());
}

// ---------------------------------------------------------------------------
// 14–18: villagers win, via several distinct routes
// ---------------------------------------------------------------------------

#[test]
fn villagers_win_by_lynching_the_lone_wolf_on_day_one() {
    let mut g = game(&[W, V, V, V, V]);
    assert_eq!(wolves_kill(&mut g, p(1)), NightOutcome::Killed(p(1)));
    assert_eq!(g.phase(), Phase::Day);

    assert_eq!(town_lynches(&mut g, p(0)), DayOutcome::Eliminated(p(0)));
    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(g.phase(), Phase::Ended);
}

#[test]
fn villagers_win_by_lynching_both_wolves_on_successive_days() {
    let mut g = game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // night 1
    town_lynches(&mut g, p(0)); // day 1: first wolf
    assert_eq!(g.winner(), None);

    wolves_kill(&mut g, p(3)); // night 2
    town_lynches(&mut g, p(1)); // day 2: last wolf
    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(g.round(), 2);
}

#[test]
fn villagers_win_on_the_last_possible_day() {
    // Six players, one wolf: the town ties votes while the wolf whittles them down, then lynches it at P0, P4, P5.
    let mut g = game(&[W, V, V, V, V, V]);
    wolves_kill(&mut g, p(1));
    town_ties(&mut g);
    wolves_kill(&mut g, p(2));
    town_ties(&mut g);
    wolves_kill(&mut g, p(3));

    assert_eq!(g.alive_count_by_role(), (2, 1)); // one more night would be parity
    town_lynches(&mut g, p(0));
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn villagers_win_when_the_pack_devours_its_own() {
    let mut g = game(&[W, W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // both wolves agree to kill wolf P1
    assert_eq!(g.alive_count_by_role(), (4, 1));

    town_lynches(&mut g, p(0)); // town finishes the last wolf
    assert_eq!(g.winner(), Some(Winner::Villagers));
}

#[test]
fn villagers_can_win_without_losing_anyone() {
    // Nine players, three wolves: the wolves kill each other and the town lynches one, leaving every villager alive.
    let mut g = game(&[W, W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // wolves kill wolf P2
    town_lynches(&mut g, p(1)); // town lynches wolf P1
    wolves_kill(&mut g, p(0)); // last wolf targets itself

    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(g.alive_count_by_role(), (6, 0));
}

// ---------------------------------------------------------------------------
// 19–23: werewolves win, via several distinct routes
// ---------------------------------------------------------------------------

#[test]
fn werewolves_win_by_attrition_while_the_town_dithers() {
    let mut g = game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1));
    town_ties(&mut g);
    wolves_kill(&mut g, p(2));
    town_ties(&mut g);
    let out = wolves_kill(&mut g, p(3)); // 1 vs 1

    assert_eq!(out, NightOutcome::Killed(p(3)));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_after_a_single_mislynch() {
    let mut g = game(&[W, V, V, V, V]);
    wolves_kill(&mut g, p(1)); // 3 villagers, 1 wolf
    town_lynches(&mut g, p(2)); // mislynch -> 2 villagers, 1 wolf
    wolves_kill(&mut g, p(3)); // 1 vs 1

    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_at_day_resolution_when_a_lynch_reaches_parity() {
    let mut g = game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // 5 villagers, 2 wolves
    town_lynches(&mut g, p(3)); // mislynch -> 4 villagers, 2 wolves
    wolves_kill(&mut g, p(4)); // 3 villagers, 2 wolves
    let out = town_lynches(&mut g, p(5)); // mislynch -> 2 vs 2

    assert_eq!(out, DayOutcome::Eliminated(p(5)));
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_at_night_with_no_day_in_between() {
    let mut g = game(&[W, W, V, V, V, V, V, V]);
    wolves_kill(&mut g, p(2)); // 5 villagers, 2 wolves
    town_lynches(&mut g, p(3)); // 4 villagers, 2 wolves
    wolves_kill(&mut g, p(4)); // 3 villagers, 2 wolves
    town_ties(&mut g); // town wastes the day
    let out = wolves_kill(&mut g, p(5)); // 2 vs 2, decided at night

    assert_eq!(out, NightOutcome::Killed(p(5)));
    assert_eq!(g.phase(), Phase::Ended); // straight to Ended, never re-entered Day
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn werewolves_win_a_long_twelve_player_game() {
    let mut roles = vec![W, W, W];
    roles.extend(std::iter::repeat_n(V, 9));
    let mut g = game(&roles);

    for target in 3..8 {
        wolves_kill(&mut g, p(target));
        town_ties(&mut g);
    }
    let out = wolves_kill(&mut g, p(8)); // brings it to 3 vs 3

    assert_eq!(out, NightOutcome::Killed(p(8)));
    assert_eq!(g.winner(), Some(Winner::Werewolves));
    assert_eq!(g.alive_count_by_role(), (3, 3));
}

// ---------------------------------------------------------------------------
// 24–28: phase & inspection invariants
// ---------------------------------------------------------------------------

#[test]
fn a_tied_vote_eliminates_nobody_and_advances_the_round() {
    let mut g = game(&[W, V, V, V, V, V]);
    wolves_kill(&mut g, p(1));
    let alive_before = g.alive().count();
    assert_eq!(g.round(), 1);

    assert_eq!(town_ties(&mut g), DayOutcome::NoElimination);
    assert_eq!(g.phase(), Phase::Night);
    assert_eq!(g.round(), 2);
    assert_eq!(g.alive().count(), alive_before);
}

#[test]
fn pending_actors_tracks_who_still_owes_an_action() {
    let mut g = game(&[W, W, V, V, V, V, V, V]);
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
fn round_only_advances_day_to_night_and_votes_clear_on_transition() {
    let mut g = game(&[W, V, V, V, V, V]);
    assert_eq!(g.round(), 1);
    assert!(g.current_votes().is_empty());

    g.night_action(p(0), p(1)).unwrap();
    g.resolve_night().unwrap(); // night -> day does not bump the round
    assert_eq!(g.round(), 1);
    assert!(g.current_votes().is_empty());

    g.vote(p(0), p(0)).unwrap();
    assert_eq!(g.current_votes().len(), 1);
    for voter in living_ids(&g).into_iter().filter(|id| *id != p(0)) {
        g.vote(voter, voter).unwrap();
    }
    assert_eq!(g.current_votes().len(), 5);

    g.resolve_day().unwrap(); // day -> night bumps the round and clears votes
    assert_eq!(g.round(), 2);
    assert!(g.current_votes().is_empty());
}

#[test]
fn alive_counts_follow_every_kill_and_lynch() {
    let mut g = game(&[W, W, V, V, V, V, V, V]);
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

    let mut a = game(&roles);
    let mut b = game(&roles);
    play(&mut a);
    play(&mut b);

    assert_eq!(a, b);
    assert_eq!(a.winner(), Some(Winner::Villagers));
}

// ---------------------------------------------------------------------------
// 29–30: unscripted full games that just have to end with a consistent winner
// ---------------------------------------------------------------------------

/// A test-local SplitMix64, since the crate's own PRNG is `pub(crate)`.
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// One element of a non-empty slice; modulo bias does not matter for a test.
    fn pick(&mut self, ids: &[PlayerId]) -> PlayerId {
        ids[(self.next_u64() % ids.len() as u64) as usize]
    }
}

/// A roster of `n` players with the same wolf count `Engine::new` would use.
fn roster(n: usize) -> Vec<Role> {
    let wolves = (n / 4).max(1);
    let mut roles = vec![W; wolves];
    roles.extend(std::iter::repeat_n(V, n - wolves));
    roles
}

/// The crowned winner must match who is actually left standing.
fn assert_winner_matches_survivors(g: &Engine) {
    assert!(g.is_over());
    assert_eq!(g.phase(), Phase::Ended);
    assert_eq!(g.pending_actors(), no_ids());

    let (villagers, wolves) = g.alive_count_by_role();
    match g.winner().expect("an ended game has a winner") {
        Winner::Villagers => assert_eq!(wolves, 0),
        Winner::Werewolves => assert!(wolves > 0 && wolves >= villagers),
    }
}

/// Play one whole game to its end: the pack always agrees on a random target;
/// the town votes randomly, or unanimously for one random target when `unanimous_town`.
fn play_out(g: &mut Engine, rng: &mut Rng, unanimous_town: bool) {
    // A unanimous pack kills one player every night, so `players` phases is a hard ceiling.
    for _ in 0..(g.players().len() * 2 + 4) {
        match g.phase() {
            Phase::Night => {
                let victim = rng.pick(&living_ids(g));
                for wolf in living_wolf_ids(g) {
                    g.night_action(wolf, victim).expect("wolf night action");
                }
                assert_eq!(
                    g.resolve_night().expect("night resolves"),
                    NightOutcome::Killed(victim),
                    "a unanimous pack never splits",
                );
            }
            Phase::Day if unanimous_town => {
                let target = rng.pick(&living_ids(g));
                for voter in living_ids(g) {
                    g.vote(voter, target).expect("vote");
                }
                assert_eq!(
                    g.resolve_day().expect("day resolves"),
                    DayOutcome::Eliminated(target),
                    "a unanimous town always eliminates its target",
                );
            }
            Phase::Day => {
                let living = living_ids(g);
                for voter in &living {
                    let target = rng.pick(&living);
                    g.vote(*voter, target).expect("vote");
                }
                g.resolve_day().expect("day resolves");
            }
            Phase::Ended => {
                assert_winner_matches_survivors(g);
                return;
            }
        }
    }
    panic!("game did not end within the phase cap");
}

/// The pack agrees; the town votes at random, so most days tie and eliminate nobody.
#[test]
fn random_town_games_always_end_with_a_consistent_winner() {
    let mut seen_villagers = false;
    let mut seen_werewolves = false;

    for n in Engine::MIN_PLAYERS..=12 {
        for seed in 0..50 {
            let mut g = game(&roster(n));
            play_out(&mut g, &mut Rng(seed), false);
            match g.winner().unwrap() {
                Winner::Villagers => seen_villagers = true,
                Winner::Werewolves => seen_werewolves = true,
            }
        }
    }

    assert!(seen_villagers, "no sweep game was a villager win");
    assert!(seen_werewolves, "no sweep game was a werewolf win");
}

/// The pack agrees and so does the town: every night and every day removes exactly one player.
#[test]
fn unanimous_town_games_always_end_with_a_consistent_winner() {
    let mut seen_villagers = false;
    let mut seen_werewolves = false;

    for n in Engine::MIN_PLAYERS..=12 {
        for seed in 0..50 {
            let mut g = game(&roster(n));
            play_out(&mut g, &mut Rng(seed), true);
            match g.winner().unwrap() {
                Winner::Villagers => seen_villagers = true,
                Winner::Werewolves => seen_werewolves = true,
            }
        }
    }

    assert!(seen_villagers, "no sweep game was a villager win");
    assert!(seen_werewolves, "no sweep game was a werewolf win");
}
