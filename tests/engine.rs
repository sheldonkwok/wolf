//! Integration tests that drive whole unscripted games to an end and assert the crowned winner matches who is left standing. The scripted per-command cases live in the engine's own unit tests.

use wolf::Role::{Villager as V, Werewolf as W};
use wolf::{DayOutcome, Engine, NightOutcome, Phase, PlayerId, Role, Winner};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Build a game from an exact roster, panicking if the roster is invalid.
fn game(roles: &[Role]) -> Engine {
    Engine::with_roles(roles).expect("roster should be valid")
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

fn no_ids() -> Vec<PlayerId> {
    Vec::new()
}

// ---------------------------------------------------------------------------
// unscripted full games that just have to end with a consistent winner
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
