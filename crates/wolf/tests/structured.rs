//! Integration tests that play whole random 12-player structured games, checking the sheriff, Fool, and last-words invariants along the way.

use wolf::rng::SplitMix64;
use wolf::{
    DayOutcome, Engine, NightOutcome, Phase, PlayerId, Role, Ruleset, SheriffOutcome, Winner,
    WitchChoice,
};

fn pick(rng: &mut SplitMix64, ids: &[PlayerId]) -> PlayerId {
    *rng.choose(ids).expect("a non-empty pool")
}

fn living(g: &Engine) -> Vec<PlayerId> {
    g.alive().map(|p| p.id()).collect()
}

/// Take one legal step for whoever the engine is waiting on.
fn step(g: &mut Engine, rng: &mut SplitMix64, seen: &mut Seen) {
    let alive = living(g);
    let pending = g.pending_actors();
    match g.phase() {
        Phase::Sheriff if !g.sheriff_voting() => {
            g.sheriff_nominate(pending[0], rng.chance(25)).unwrap();
        }
        Phase::Sheriff => {
            let candidates = g.sheriff_candidates();
            if g.majority_target().is_some() || pending.is_empty() {
                let election = g.resolve_sheriff().unwrap();
                assert_eq!(g.pending_last_words(), election.deaths);
                assert!(election.deaths.iter().all(|&id| !g.is_alive(id)));
                match election.outcome {
                    SheriffOutcome::Elected(id) => {
                        assert!(candidates.contains(&id));
                        seen.elected = true;
                    }
                    SheriffOutcome::Tied => seen.no_sheriff = true,
                }
                assert_ne!(g.phase(), Phase::Sheriff);
            } else if rng.chance(5) {
                g.sheriff_withdraw(pick(rng, &candidates)).unwrap();
                seen.withdrawn = true;
            } else {
                g.sheriff_vote(pending[0], pick(rng, &candidates)).unwrap();
            }
        }
        Phase::Badge => {
            let successor = rng.chance(70).then(|| pick(rng, &alive));
            g.pass_badge(pending[0], successor).unwrap();
            assert_eq!(g.sheriff(), successor);
            seen.badge_passed |= successor.is_some();
        }
        Phase::Day => {
            for words in g.pending_last_words() {
                g.last_words(words).unwrap();
                seen.last_words = true;
            }
            if g.majority_target().is_some() || pending.is_empty() {
                let before = g.revealed_fool();
                match g.resolve_day().unwrap() {
                    DayOutcome::FoolRevealed(id) => {
                        assert_eq!(before, None);
                        assert!(g.is_alive(id) && !g.can_vote(id));
                        assert_eq!(g.role_of(id), Ok(Role::Fool));
                        seen.fool_revealed = true;
                    }
                    DayOutcome::Eliminated(id) => assert!(!g.is_alive(id)),
                    DayOutcome::Tied => {}
                }
                assert!(g.pending_last_words().is_empty());
            } else {
                g.vote(pending[0], pick(rng, &alive)).unwrap();
            }
        }
        Phase::Night => {
            let Some(&actor) = pending.first() else {
                let round = g.round();
                match g.resolve_night().unwrap() {
                    NightOutcome::Election => assert_eq!(round, 1),
                    NightOutcome::Dawn { .. } => {
                        assert!(round > 1);
                        assert!(g.pending_last_words().is_empty());
                    }
                    _ => {}
                }
                return;
            };
            match g.role_of(actor).unwrap() {
                Role::Werewolf => {
                    let wolves = g.alive_count_by_role().1;
                    let agreed = g.current_night_picks().values().next().copied();
                    let others: Vec<_> = alive.iter().copied().filter(|&id| id != actor).collect();
                    let target = agreed
                        .unwrap_or_else(|| pick(rng, if wolves > 1 { &alive } else { &others }));
                    g.night_action(actor, target).unwrap();
                }
                Role::Seer => {
                    g.seer_action(actor, pick(rng, &alive)).unwrap();
                }
                Role::Witch => {
                    let others: Vec<_> = alive.iter().copied().filter(|&id| id != actor).collect();
                    let choice = if g.heal_available() && rng.chance(40) {
                        WitchChoice::Heal
                    } else if g.poison_available() && rng.chance(30) {
                        WitchChoice::Poison(pick(rng, &others))
                    } else {
                        WitchChoice::Pass
                    };
                    g.witch_action(actor, choice).unwrap();
                }
                role => panic!("{role:?} is never pending at night"),
            }
        }
        Phase::Hunter => g.hunter_action(pending[0], pick(rng, &alive)).unwrap(),
        Phase::Ended => {}
    }
}

#[derive(Default)]
struct Seen {
    elected: bool,
    no_sheriff: bool,
    fool_revealed: bool,
    last_words: bool,
    withdrawn: bool,
    badge_passed: bool,
    villagers: bool,
    werewolves: bool,
}

#[test]
fn random_structured_games_end_with_a_consistent_winner() {
    let mut seen = Seen::default();
    for seed in 0..300 {
        let mut g = Engine::with_seed(Engine::STRUCTURED_PLAYERS, seed).unwrap();
        assert_eq!(g.ruleset(), Ruleset::Structured);
        let mut rng = SplitMix64::new(seed ^ 0x5eed);
        let mut steps = 0;
        while !g.is_over() {
            steps += 1;
            assert!(steps < 5_000, "seed={seed} did not end");
            step(&mut g, &mut rng, &mut seen);
        }
        let (villagers, wolves) = g.alive_count_by_role();
        match g.winner().unwrap() {
            Winner::Villagers => {
                assert_eq!(wolves, 0);
                seen.villagers = true;
            }
            Winner::Werewolves => {
                assert!(wolves >= villagers);
                seen.werewolves = true;
            }
        }
    }
    assert!(seen.elected && seen.no_sheriff, "both election results");
    assert!(seen.fool_revealed, "a fool was revealed");
    assert!(
        seen.withdrawn && seen.badge_passed,
        "candidates withdrew and badges were passed"
    );
    assert!(seen.last_words, "last words were shared");
    assert!(seen.villagers && seen.werewolves, "both teams won");
}
