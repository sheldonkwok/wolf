//! The witch through the public API: turn order, potions across nights, hunter and victory interplay, and a random-command fuzz that checks every transition.

use std::collections::BTreeSet;

use Role::{Doctor as D, Hunter as H, Seer as S, Villager as V, Werewolf as W, Witch as X};
use wolf::rng::SplitMix64;
use wolf::{
    DayOutcome, Engine, GameError, NightOutcome, Phase, PlayerId, Role, Winner, WitchChoice,
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// A command that should be rejected, as a closure over the game.
type Command<'a> = &'a dyn Fn(&mut Engine) -> Result<(), GameError>;

fn p(index: usize) -> PlayerId {
    PlayerId(index)
}

fn living(g: &Engine) -> Vec<PlayerId> {
    g.alive().map(|p| p.id()).collect()
}

fn living_role(g: &Engine, role: Role) -> Vec<PlayerId> {
    g.alive()
        .filter(|p| p.role() == role)
        .map(|p| p.id())
        .collect()
}

fn dawn(saved: Option<usize>, deaths: &[usize]) -> NightOutcome {
    NightOutcome::Dawn {
        saved: saved.map(PlayerId),
        deaths: deaths.iter().copied().map(PlayerId).collect(),
    }
}

/// Everyone votes for the next living player, so the ballot ties and night begins with nobody eliminated.
fn tie_day(g: &mut Engine) {
    let ids = living(g);
    for (i, &voter) in ids.iter().enumerate() {
        g.vote(voter, ids[(i + 1) % ids.len()]).unwrap();
    }
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Tied));
}

fn lynch(g: &mut Engine, target: usize) {
    for voter in living(g) {
        g.vote(voter, p(target)).unwrap();
    }
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(target))));
}

/// The pack attacks, the doctor protects `protect`, the seer inspects, and the night is resolved once.
fn dusk(g: &mut Engine, attack: usize, protect: Option<usize>) -> NightOutcome {
    for wolf in living_role(g, W) {
        g.night_action(wolf, p(attack)).unwrap();
    }
    for doctor in living_role(g, D) {
        g.doctor_action(doctor, p(protect.expect("a doctor needs a target")))
            .unwrap();
    }
    for seer in living_role(g, S) {
        g.seer_action(seer, p(attack)).unwrap();
    }
    g.resolve_night().unwrap()
}

/// A full night in which the witch must be offered a turn and takes `choice`.
fn night(
    g: &mut Engine,
    attack: usize,
    protect: Option<usize>,
    choice: WitchChoice,
) -> NightOutcome {
    assert_eq!(dusk(g, attack, protect), NightOutcome::AwaitingWitch);
    let witch = living_role(g, X)[0];
    g.witch_action(witch, choice).unwrap();
    g.resolve_night().unwrap()
}

/// A game that has reached Night 1 with everyone alive.
fn night_one(roles: &[Role]) -> Engine {
    let mut g = Engine::with_roles(roles).unwrap();
    tie_day(&mut g);
    assert_eq!((g.phase(), g.round()), (Phase::Night, 1));
    g
}

// ---------------------------------------------------------------------------
// turn order
// ---------------------------------------------------------------------------

#[test]
fn the_witch_cannot_act_until_the_pack_is_locked() {
    let mut g = Engine::with_roles(&[W, W, X, D, S, V, V]).unwrap();
    // Day 1: potions are untouched and no command reaches the witch.
    for choice in [
        WitchChoice::Heal,
        WitchChoice::Pass,
        WitchChoice::Poison(p(0)),
    ] {
        let before = g.clone();
        assert_eq!(
            g.witch_action(p(2), choice),
            Err(GameError::WrongPhase {
                expected: Phase::Night,
                actual: Phase::Day
            })
        );
        assert_eq!(g, before);
    }
    tie_day(&mut g);
    assert_eq!(g.pending_actors(), vec![p(0), p(1), p(3), p(4)]);
    assert_eq!(g.witch_victim(), None);

    // The witch is never pending while the other night roles are still choosing.
    let steps: [&dyn Fn(&mut Engine); 4] = [
        &|g| g.night_action(p(0), p(5)).unwrap(),
        &|g| g.doctor_action(p(3), p(6)).unwrap(),
        &|g| g.night_action(p(1), p(5)).unwrap(),
        &|g| g.seer_action(p(4), p(0)).map(|_| ()).unwrap(),
    ];
    for step in steps {
        for choice in [
            WitchChoice::Heal,
            WitchChoice::Pass,
            WitchChoice::Poison(p(0)),
        ] {
            let before = g.clone();
            assert_eq!(g.witch_action(p(2), choice), Err(GameError::PackUndecided));
            assert_eq!(g, before);
        }
        assert!(!g.pending_actors().contains(&p(2)));
        assert!(matches!(
            g.resolve_night(),
            Err(GameError::ActionsIncomplete { .. })
        ));
        step(&mut g);
    }
    assert_eq!(g.pending_actors(), Vec::new());
    assert_eq!(
        g.witch_action(p(2), WitchChoice::Pass),
        Err(GameError::PackUndecided)
    );

    assert_eq!(g.resolve_night(), Ok(NightOutcome::AwaitingWitch));
    assert_eq!((g.phase(), g.round()), (Phase::Night, 1));
    assert_eq!(g.pending_actors(), vec![p(2)]);
    assert_eq!(g.witch_victim(), Some(p(5)));
    assert_eq!(g.alive().count(), 7);
}

#[test]
fn the_locked_night_accepts_only_the_witch() {
    let mut g = night_one(&[W, W, X, D, S, H, V, V]);
    assert_eq!(dusk(&mut g, 6, Some(7)), NightOutcome::AwaitingWitch);
    let locked = g.clone();
    let rejections: [(&str, Command, GameError); 10] = [
        (
            "resolve",
            &|g| g.resolve_night().map(|_| ()),
            GameError::ActionsIncomplete {
                waiting_on: vec![p(2)],
            },
        ),
        (
            "wolf repick",
            &|g| g.night_action(p(0), p(7)),
            GameError::AlreadyActed(p(0)),
        ),
        (
            "wolf same pick",
            &|g| g.night_action(p(1), p(6)),
            GameError::AlreadyActed(p(1)),
        ),
        (
            "doctor",
            &|g| g.doctor_action(p(3), p(6)),
            GameError::AlreadyActed(p(3)),
        ),
        (
            "seer",
            &|g| g.seer_action(p(4), p(1)).map(|_| ()),
            GameError::AlreadyActed(p(4)),
        ),
        (
            "vote",
            &|g| g.vote(p(6), p(0)),
            GameError::WrongPhase {
                expected: Phase::Day,
                actual: Phase::Night,
            },
        ),
        (
            "hunter",
            &|g| g.hunter_action(p(5), p(0)),
            GameError::WrongPhase {
                expected: Phase::Hunter,
                actual: Phase::Night,
            },
        ),
        (
            "not the witch",
            &|g| g.witch_action(p(6), WitchChoice::Pass),
            GameError::NotAWitch(p(6)),
        ),
        (
            "wolf as witch",
            &|g| g.witch_action(p(0), WitchChoice::Heal),
            GameError::NotAWitch(p(0)),
        ),
        (
            "unknown witch",
            &|g| g.witch_action(p(99), WitchChoice::Pass),
            GameError::UnknownPlayer(p(99)),
        ),
    ];
    for (name, command, error) in rejections {
        assert_eq!(command(&mut g), Err(error), "{name}");
        assert_eq!(g, locked, "{name} changed the locked night");
    }

    // Her choice is final: nothing can follow it but the resolution.
    g.witch_action(p(2), WitchChoice::Poison(p(0))).unwrap();
    let chosen = g.clone();
    for choice in [
        WitchChoice::Heal,
        WitchChoice::Pass,
        WitchChoice::Poison(p(1)),
    ] {
        assert_eq!(
            g.witch_action(p(2), choice),
            Err(GameError::AlreadyActed(p(2)))
        );
    }
    assert_eq!(
        g.night_action(p(0), p(7)),
        Err(GameError::AlreadyActed(p(0)))
    );
    assert_eq!(g, chosen);
    assert_eq!(g.resolve_night(), Ok(dawn(None, &[0, 6])));
    assert_eq!((g.phase(), g.round()), (Phase::Day, 2));
    assert_eq!(
        g.witch_action(p(2), WitchChoice::Pass),
        Err(GameError::WrongPhase {
            expected: Phase::Night,
            actual: Phase::Day
        })
    );
}

#[test]
fn a_split_pack_repicks_before_the_witch_sees_anything() {
    let mut g = night_one(&[W, W, X, D, S, V, V]);
    g.night_action(p(0), p(5)).unwrap();
    g.night_action(p(1), p(6)).unwrap();
    g.doctor_action(p(3), p(5)).unwrap();
    g.seer_action(p(4), p(0)).unwrap();
    assert_eq!(
        g.resolve_night(),
        Ok(NightOutcome::NoConsensus {
            targets: vec![p(5), p(6)]
        })
    );
    assert_eq!(g.witch_victim(), None);
    assert_eq!(g.pending_actors(), vec![p(0), p(1)]);
    assert_eq!(
        g.witch_action(p(2), WitchChoice::Heal),
        Err(GameError::PackUndecided)
    );
    assert!(g.heal_available());

    // Only the pack chooses again; the doctor's protection is still in place when the witch is shown the target.
    g.night_action(p(0), p(5)).unwrap();
    g.night_action(p(1), p(5)).unwrap();
    assert_eq!(g.resolve_night(), Ok(NightOutcome::AwaitingWitch));
    assert_eq!(g.witch_victim(), Some(p(5)));
    g.witch_action(p(2), WitchChoice::Pass).unwrap();
    assert_eq!(g.resolve_night(), Ok(dawn(Some(5), &[])));
    assert!(g.heal_available() && g.poison_available());
}

// ---------------------------------------------------------------------------
// potions across nights
// ---------------------------------------------------------------------------

#[test]
fn every_four_night_sequence_spends_each_potion_at_most_once() {
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Want {
        Heal,
        Poison,
        Pass,
    }
    let wants = [Want::Heal, Want::Poison, Want::Pass];
    let mut sequences = 0;
    for a in wants {
        for b in wants {
            for c in wants {
                for d in wants {
                    sequences += 1;
                    // The doctor always blocks the attack on seat 3, so only poison ever kills.
                    let mut g = Engine::with_roles(&[W, X, D, V, V, V, V, V, V, V, V, V]).unwrap();
                    let (mut heal, mut poison) = (true, true);
                    let mut victim = 11;
                    for (index, want) in [a, b, c, d].into_iter().enumerate() {
                        let context = format!("sequence {:?} night {}", [a, b, c, d], index + 1);
                        tie_day(&mut g);
                        let before_night = living(&g);
                        let first = dusk(&mut g, 3, Some(3));
                        if !heal && !poison {
                            // An empty-handed witch is skipped entirely.
                            assert_eq!(first, dawn(Some(3), &[]), "{context}");
                            assert_eq!(living(&g), before_night);
                            continue;
                        }
                        assert_eq!(first, NightOutcome::AwaitingWitch, "{context}");
                        assert_eq!(g.pending_actors(), vec![p(1)]);
                        // Once the heal is spent she is no longer told who was attacked.
                        assert_eq!(g.witch_victim(), heal.then_some(p(3)), "{context}");

                        let choice = match want {
                            Want::Heal => WitchChoice::Heal,
                            Want::Poison => WitchChoice::Poison(p(victim)),
                            Want::Pass => WitchChoice::Pass,
                        };
                        let allowed = match want {
                            Want::Heal => heal,
                            Want::Poison => poison,
                            Want::Pass => true,
                        };
                        let mut deaths = Vec::new();
                        if allowed {
                            g.witch_action(p(1), choice).unwrap();
                            match want {
                                Want::Heal => heal = false,
                                Want::Poison => {
                                    poison = false;
                                    deaths.push(victim);
                                    victim -= 1;
                                }
                                Want::Pass => {}
                            }
                        } else {
                            let before = g.clone();
                            assert_eq!(
                                g.witch_action(p(1), choice),
                                Err(GameError::PotionSpent(p(1))),
                                "{context}"
                            );
                            assert_eq!(g, before, "{context}");
                            g.witch_action(p(1), WitchChoice::Pass).unwrap();
                        }
                        assert_eq!(g.resolve_night(), Ok(dawn(Some(3), &deaths)), "{context}");
                        assert_eq!(g.heal_available(), heal, "{context}");
                        assert_eq!(g.poison_available(), poison, "{context}");
                        assert_eq!(g.alive().count(), before_night.len() - deaths.len());
                        assert_eq!((g.phase(), g.round()), (Phase::Day, index + 2));
                    }
                }
            }
        }
    }
    assert_eq!(sequences, 81);
}

#[test]
fn a_redundant_heal_is_spent_and_poison_ignores_protection() {
    // The doctor already protects the target, yet the heal is gone for good.
    let mut g = night_one(&[W, X, D, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, Some(3), WitchChoice::Heal),
        dawn(Some(3), &[])
    );
    assert!(!g.heal_available());
    tie_day(&mut g);
    assert_eq!(dusk(&mut g, 3, Some(4)), NightOutcome::AwaitingWitch);
    assert_eq!(g.witch_victim(), None);
    assert_eq!(
        g.witch_action(p(1), WitchChoice::Heal),
        Err(GameError::PotionSpent(p(1)))
    );
    g.witch_action(p(1), WitchChoice::Pass).unwrap();
    assert_eq!(g.resolve_night(), Ok(dawn(None, &[3])));

    // Protection stops the pack, not the poison: the protected target is not reported as saved.
    let mut g = night_one(&[W, X, D, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, Some(3), WitchChoice::Poison(p(3))),
        dawn(None, &[3])
    );
    // Poisoning the pack's own unprotected target kills them exactly once.
    let mut g = night_one(&[W, X, D, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, Some(4), WitchChoice::Poison(p(3))),
        dawn(None, &[3])
    );
    assert_eq!(g.alive().count(), 6);
    assert!(g.heal_available() && !g.poison_available());
    // A protected target lives while the poison takes someone else.
    let mut g = night_one(&[W, X, D, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, Some(3), WitchChoice::Poison(p(4))),
        dawn(Some(3), &[4])
    );
}

#[test]
fn poison_rejects_bad_targets_without_spending_the_potion() {
    let mut g = Engine::with_roles(&[W, X, V, V, V, V]).unwrap();
    lynch(&mut g, 5);
    assert_eq!(dusk(&mut g, 2, None), NightOutcome::AwaitingWitch);
    let before = g.clone();
    for (target, error) in [
        (1, GameError::WitchCannotPoisonSelf),
        (5, GameError::PlayerNotAlive(p(5))),
        (99, GameError::UnknownPlayer(p(99))),
    ] {
        assert_eq!(
            g.witch_action(p(1), WitchChoice::Poison(p(target))),
            Err(error)
        );
        assert_eq!(g, before);
    }
    assert!(g.poison_available());
    assert_eq!(g.pending_actors(), vec![p(1)]);
    g.witch_action(p(1), WitchChoice::Poison(p(3))).unwrap();
    assert_eq!(g.resolve_night(), Ok(dawn(None, &[2, 3])));
}

// ---------------------------------------------------------------------------
// the witch as a target
// ---------------------------------------------------------------------------

#[test]
fn an_attacked_witch_may_heal_herself_or_strike_back() {
    let mut g = night_one(&[W, W, X, V, V, V, V]);
    assert_eq!(
        night(&mut g, 2, None, WitchChoice::Heal),
        dawn(Some(2), &[])
    );
    assert!(g.is_alive(p(2)));
    assert!(!g.heal_available() && g.poison_available());

    // Her action still counts on the night she dies, and her remaining potion dies with her.
    let mut g = night_one(&[W, W, X, V, V, V, V]);
    assert_eq!(
        night(&mut g, 2, None, WitchChoice::Poison(p(0))),
        dawn(None, &[0, 2])
    );
    assert_eq!((g.phase(), g.round()), (Phase::Day, 2));
    assert!(g.heal_available() && !g.poison_available());
    tie_day(&mut g);
    assert_eq!(dusk(&mut g, 3, None), dawn(None, &[3]));
    assert_eq!(
        g.witch_action(p(2), WitchChoice::Pass),
        Err(GameError::WrongPhase {
            expected: Phase::Night,
            actual: Phase::Day
        })
    );
}

#[test]
fn a_dead_witch_never_gets_a_turn() {
    // Voted out by day.
    let mut g = Engine::with_roles(&[W, X, V, V, V, V, V]).unwrap();
    lynch(&mut g, 1);
    g.night_action(p(0), p(2)).unwrap();
    assert_eq!(g.pending_actors(), Vec::new());
    assert_eq!(
        g.witch_action(p(1), WitchChoice::Heal),
        Err(GameError::PlayerNotAlive(p(1)))
    );
    assert_eq!(g.resolve_night(), Ok(dawn(None, &[2])));
    assert!(g.heal_available() && g.poison_available());

    // Killed at night after passing: the next night skips her.
    let mut g = night_one(&[W, X, V, V, V, V, V]);
    assert_eq!(night(&mut g, 1, None, WitchChoice::Pass), dawn(None, &[1]));
    tie_day(&mut g);
    assert_eq!(dusk(&mut g, 2, None), dawn(None, &[2]));

    // Shot by the hunter.
    let mut g = Engine::with_roles(&[W, X, H, V, V, V, V]).unwrap();
    lynch(&mut g, 2);
    g.hunter_action(p(2), p(1)).unwrap();
    assert_eq!((g.phase(), g.round()), (Phase::Night, 1));
    assert_eq!(dusk(&mut g, 3, None), dawn(None, &[3]));
    assert_eq!(g.witch_victim(), None);
}

// ---------------------------------------------------------------------------
// hunter and victory interplay
// ---------------------------------------------------------------------------

#[test]
fn a_poisoned_hunter_still_shoots_and_a_healed_hunter_does_not() {
    // Poisoned while someone else is attacked: two deaths, then the shot makes three.
    let mut g = night_one(&[W, W, X, H, V, V, V, V, V]);
    assert_eq!(
        night(&mut g, 4, None, WitchChoice::Poison(p(3))),
        dawn(None, &[3, 4])
    );
    assert_eq!((g.phase(), g.round()), (Phase::Hunter, 1));
    assert_eq!(g.pending_actors(), vec![p(3)]);
    assert_eq!(
        g.hunter_action(p(2), p(0)),
        Err(GameError::NotPendingHunter(p(2)))
    );
    assert_eq!(
        g.hunter_action(p(3), p(4)),
        Err(GameError::PlayerNotAlive(p(4)))
    );
    g.hunter_action(p(3), p(5)).unwrap();
    assert_eq!((g.phase(), g.round()), (Phase::Day, 2));
    assert_eq!(living(&g), vec![p(0), p(1), p(2), p(6), p(7), p(8)]);

    // Attacked and poisoned on the same night: one death, one shot.
    let mut g = night_one(&[W, W, X, H, V, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, None, WitchChoice::Poison(p(3))),
        dawn(None, &[3])
    );
    assert_eq!(g.phase(), Phase::Hunter);
    g.hunter_action(p(3), p(0)).unwrap();
    assert_eq!(
        g.hunter_action(p(3), p(1)).unwrap_err(),
        GameError::WrongPhase {
            expected: Phase::Hunter,
            actual: Phase::Day
        }
    );
    assert_eq!(g.alive().count(), 7);

    // Healed: alive at dawn, so there is no shot.
    let mut g = night_one(&[W, W, X, H, V, V, V, V, V]);
    assert_eq!(
        night(&mut g, 3, None, WitchChoice::Heal),
        dawn(Some(3), &[])
    );
    assert_eq!((g.phase(), g.round()), (Phase::Day, 2));
    assert!(g.is_alive(p(3)));

    // The hunter may shoot the witch who poisoned them.
    let mut g = night_one(&[W, W, X, H, V, V, V, V, V]);
    night(&mut g, 4, None, WitchChoice::Poison(p(3)));
    g.hunter_action(p(3), p(2)).unwrap();
    tie_day(&mut g);
    assert!(matches!(dusk(&mut g, 5, None), NightOutcome::Dawn { .. }));
}

#[test]
fn victory_waits_for_the_poisoned_hunter() {
    // Wolf, witch, hunter, villager: the attack and the poison leave wolf against witch, but the shot decides it.
    for (shot, winner) in [(0, Winner::Villagers), (1, Winner::Werewolves)] {
        let mut g = Engine::with_roles(&[W, X, H, V, V]).unwrap();
        lynch(&mut g, 4);
        assert_eq!(
            night(&mut g, 3, None, WitchChoice::Poison(p(2))),
            dawn(None, &[2, 3])
        );
        assert_eq!(g.phase(), Phase::Hunter);
        assert_eq!(g.winner(), None);
        assert_eq!(g.alive_count_by_role(), (1, 1));
        g.hunter_action(p(2), p(shot)).unwrap();
        assert_eq!(g.winner(), Some(winner));
        assert_eq!(g.phase(), Phase::Ended);
        assert_eq!(
            g.witch_action(p(1), WitchChoice::Pass),
            Err(GameError::GameOver)
        );
    }
}

#[test]
fn poison_decides_games_in_both_directions() {
    // The last wolf is poisoned on the night its attack lands: the village still wins.
    let mut g = Engine::with_roles(&[W, X, V, V, V]).unwrap();
    lynch(&mut g, 4);
    assert_eq!(
        night(&mut g, 3, None, WitchChoice::Poison(p(0))),
        dawn(None, &[0, 3])
    );
    assert_eq!(g.winner(), Some(Winner::Villagers));

    // Poisoning an innocent on top of the attack hands the wolves parity.
    let mut g = Engine::with_roles(&[W, X, V, V, V]).unwrap();
    lynch(&mut g, 4);
    assert_eq!(
        night(&mut g, 3, None, WitchChoice::Poison(p(2))),
        dawn(None, &[2, 3])
    );
    assert_eq!(g.winner(), Some(Winner::Werewolves));

    // Healing at the brink keeps the game alive for another day.
    let mut g = Engine::with_roles(&[W, X, V, V, V]).unwrap();
    lynch(&mut g, 4);
    tie_day_after(&mut g, 3, WitchChoice::Pass);
    assert_eq!(
        night(&mut g, 2, None, WitchChoice::Heal),
        dawn(Some(2), &[])
    );
    assert_eq!(g.winner(), None);
    assert_eq!((g.phase(), g.round()), (Phase::Day, 3));

    // Without the heal the same night ends the game.
    let mut g = Engine::with_roles(&[W, X, V, V, V]).unwrap();
    lynch(&mut g, 4);
    tie_day_after(&mut g, 3, WitchChoice::Pass);
    assert_eq!(night(&mut g, 2, None, WitchChoice::Pass), dawn(None, &[2]));
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

/// One night with the given attack and witch choice, then a tied day.
fn tie_day_after(g: &mut Engine, attack: usize, choice: WitchChoice) {
    night(g, attack, None, choice);
    tie_day(g);
}

#[test]
fn the_witch_is_dealt_at_most_once_and_wins_with_the_village() {
    let mut dealt = 0;
    for count in 5..=24 {
        for seed in 0..40 {
            let g = Engine::with_seed(count, seed).unwrap();
            let witches = g.players().iter().filter(|p| p.role() == X).count();
            assert!(witches <= 1);
            assert!(
                count < 19 || witches == 1,
                "large tables hold every special role"
            );
            dealt += witches;
            assert_eq!(
                g.alive_count_by_role(),
                (count - (count / 3).max(1), (count / 3).max(1))
            );
            assert!(g.heal_available() && g.poison_available());
            assert_eq!(g.witch_victim(), None);
        }
    }
    assert!(
        dealt > 100,
        "the witch should be a regular draw, got {dealt}"
    );
    assert!(matches!(
        Engine::with_roles(&[W, X, X, V, V]),
        Err(GameError::InvalidRoster(_))
    ));
    // Wolf against witch is parity: she counts as a villager.
    let mut g = Engine::with_roles(&[W, X, V, V, V]).unwrap();
    lynch(&mut g, 4);
    night(&mut g, 3, None, WitchChoice::Pass);
    lynch(&mut g, 2);
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

// ---------------------------------------------------------------------------
// random-command fuzz
// ---------------------------------------------------------------------------

/// What the fuzz reached, so a silent loss of coverage fails the test.
#[derive(Default)]
struct Coverage {
    rejected: usize,
    heals: usize,
    poisons: usize,
    passes: usize,
    double_deaths: usize,
    witch_turns: usize,
    skipped_turns: usize,
    hunter_pauses_at_night: usize,
    villager_wins: usize,
    werewolf_wins: usize,
}

fn any_seat(rng: &mut SplitMix64, g: &Engine) -> PlayerId {
    // One past the table, so unknown players are part of the mix.
    PlayerId(rng.below(g.players().len() as u64 + 1) as usize)
}

fn pick(rng: &mut SplitMix64, ids: &[PlayerId]) -> PlayerId {
    *rng.choose(ids).expect("a non-empty pool")
}

/// One command that is legal right now and moves the game forward.
fn progress(g: &mut Engine, rng: &mut SplitMix64) -> Result<Option<NightOutcome>, GameError> {
    let alive = living(g);
    let pending = g.pending_actors();
    match g.phase() {
        Phase::Night => {
            let Some(&actor) = pending.first() else {
                return g.resolve_night().map(Some);
            };
            match g.role_of(actor).unwrap() {
                Role::Werewolf => {
                    let wolves = living_role(g, W);
                    // Mostly follow the pack so nights resolve, sometimes split it.
                    let agreed = g.current_night_picks().values().next().copied();
                    let target = match agreed {
                        Some(target) if rng.chance(85) => target,
                        _ => {
                            let pool: Vec<_> = alive
                                .iter()
                                .copied()
                                .filter(|id| wolves.len() > 1 || *id != actor)
                                .collect();
                            pick(rng, &pool)
                        }
                    };
                    g.night_action(actor, target).map(|()| None)
                }
                Role::Doctor => g.doctor_action(actor, pick(rng, &alive)).map(|()| None),
                Role::Seer => g.seer_action(actor, pick(rng, &alive)).map(|_| None),
                Role::Witch => {
                    let mut options = vec![WitchChoice::Pass];
                    if g.heal_available() {
                        options.push(WitchChoice::Heal);
                    }
                    if g.poison_available() {
                        let others: Vec<_> =
                            alive.iter().copied().filter(|id| *id != actor).collect();
                        options.push(WitchChoice::Poison(pick(rng, &others)));
                    }
                    let choice = options[rng.below(options.len() as u64) as usize];
                    g.witch_action(actor, choice).map(|()| None)
                }
                role => panic!("{role:?} is never pending at night"),
            }
        }
        Phase::Day => {
            if g.majority_target().is_some() || pending.is_empty() {
                g.resolve_day().map(|_| None)
            } else {
                g.vote(pending[0], pick(rng, &alive)).map(|()| None)
            }
        }
        Phase::Hunter => g
            .hunter_action(pending[0], pick(rng, &alive))
            .map(|()| None),
        Phase::Ended => Ok(None),
    }
}

/// Any command at all, from any seat, legal or not.
fn chaos(g: &mut Engine, rng: &mut SplitMix64) -> Result<Option<NightOutcome>, GameError> {
    let (actor, target) = (any_seat(rng, g), any_seat(rng, g));
    match rng.below(9) {
        0 => g.vote(actor, target).map(|()| None),
        1 => g.night_action(actor, target).map(|()| None),
        2 => g.doctor_action(actor, target).map(|()| None),
        3 => g.seer_action(actor, target).map(|_| None),
        4 => g.hunter_action(actor, target).map(|()| None),
        5 => g.resolve_day().map(|_| None),
        6 => g.resolve_night().map(Some),
        _ => {
            // Aim at the real witch half the time so her rejections are exercised too.
            let witch = living_role(g, X).first().copied().unwrap_or(actor);
            let actor = if rng.chance(50) { witch } else { actor };
            let choice = match rng.below(3) {
                0 => WitchChoice::Heal,
                1 => WitchChoice::Poison(target),
                _ => WitchChoice::Pass,
            };
            g.witch_action(actor, choice).map(|()| None)
        }
    }
}

/// Invariants that must hold in every reachable state.
fn check_state(g: &Engine, context: &str) {
    let pending = g.pending_actors();
    let witches = living_role(g, X);
    let (villagers, wolves) = g.alive_count_by_role();

    if let Some(victim) = g.witch_victim() {
        assert_eq!(g.phase(), Phase::Night, "{context}");
        assert!(g.heal_available(), "{context}");
        assert!(g.is_alive(victim), "{context}");
        assert_eq!(pending, witches, "{context}");
        assert_eq!(witches.len(), 1, "{context}");
    }
    if g.phase() == Phase::Night && pending.iter().any(|id| g.role_of(*id) == Ok(X)) {
        assert_eq!(pending, witches, "a pending witch acts alone: {context}");
        assert!(g.heal_available() || g.poison_available(), "{context}");
        // Nobody else can still change the night she is deciding.
        assert_eq!(g.current_night_picks().len(), wolves, "{context}");
    }
    match g.phase() {
        Phase::Ended => {
            assert!(pending.is_empty(), "{context}");
            match g.winner().expect("an ended game has a winner") {
                Winner::Villagers => assert_eq!(wolves, 0, "{context}"),
                Winner::Werewolves => assert!(wolves > 0 && wolves >= villagers, "{context}"),
            }
        }
        Phase::Hunter => {
            assert_eq!(g.winner(), None, "{context}");
            assert_eq!(pending.len(), 1, "{context}");
            assert_eq!(g.role_of(pending[0]), Ok(H), "{context}");
            assert!(!g.is_alive(pending[0]), "{context}");
        }
        Phase::Day | Phase::Night => {
            assert_eq!(g.winner(), None, "{context}");
            assert!(
                wolves > 0 && wolves < villagers,
                "an undecided game: {context}"
            );
            assert!(pending.iter().all(|id| g.is_alive(*id)), "{context}");
        }
    }
}

/// Invariants linking the state before a successful command to the state after it.
fn check_step(before: &Engine, after: &Engine, outcome: &Option<NightOutcome>, context: &str) {
    assert!(
        before.heal_available() || !after.heal_available(),
        "heal came back: {context}"
    );
    assert!(
        before.poison_available() || !after.poison_available(),
        "poison came back: {context}"
    );
    let spent = usize::from(before.heal_available() != after.heal_available())
        + usize::from(before.poison_available() != after.poison_available());
    assert!(spent <= 1, "two potions in one command: {context}");

    let was: BTreeSet<_> = living(before).into_iter().collect();
    let now: BTreeSet<_> = living(after).into_iter().collect();
    assert!(now.is_subset(&was), "a player came back to life: {context}");
    let died: Vec<_> = was.difference(&now).copied().collect();
    assert!(died.len() <= 2, "{context}");
    assert!(after.round() >= before.round(), "{context}");

    match outcome {
        Some(NightOutcome::Dawn { saved, deaths }) => {
            assert_eq!(&died, deaths, "{context}");
            if let Some(saved) = saved {
                assert!(after.is_alive(*saved), "{context}");
                assert!(!deaths.contains(saved), "{context}");
            }
            assert_ne!(after.phase(), Phase::Night, "{context}");
            assert_eq!(after.witch_victim(), None, "{context}");
            assert!(after.current_doctor_picks().is_empty(), "{context}");
        }
        Some(NightOutcome::AwaitingWitch) => {
            assert!(died.is_empty(), "{context}");
            assert_eq!(after.phase(), Phase::Night, "{context}");
            assert_eq!(after.pending_actors(), living_role(after, X), "{context}");
            assert_eq!(
                after.current_night_picks(),
                before.current_night_picks(),
                "{context}"
            );
        }
        Some(NightOutcome::NoConsensus { targets }) => {
            assert!(died.is_empty() && targets.len() > 1, "{context}");
            assert_eq!(after.phase(), Phase::Night, "{context}");
            assert_eq!(after.witch_victim(), None, "{context}");
        }
        None => assert!(died.len() <= 1, "only a night can kill two: {context}"),
    }
}

/// A valid roster of `count` seats that always seats the witch beside a random mix of other roles.
fn fuzz_roster(count: usize, rng: &mut SplitMix64) -> Vec<Role> {
    let wolves = (count / 3).max(1);
    let mut roles = vec![W; wolves];
    roles.push(X);
    for role in [D, S, H] {
        if roles.len() < count && rng.chance(60) {
            roles.push(role);
        }
    }
    roles.resize(count, V);
    rng.shuffle(&mut roles);
    roles
}

#[test]
fn random_commands_never_break_the_night() {
    let mut seen = Coverage::default();
    for count in Engine::MIN_PLAYERS..=12 {
        for seed in 0..150 {
            let mut rng = SplitMix64::new(seed * 131 + count as u64);
            let roles = fuzz_roster(count, &mut rng);
            let mut g = Engine::with_roles(&roles).unwrap();
            let (mut heals, mut poisons) = (0, 0);
            let mut steps = 0;
            while !g.is_over() {
                steps += 1;
                assert!(
                    steps < 20_000,
                    "game did not end: roles={roles:?} seed={seed}"
                );
                let before = g.clone();
                let result = if rng.chance(35) {
                    progress(&mut g, &mut rng)
                } else {
                    chaos(&mut g, &mut rng)
                };
                let context = format!("roles={roles:?} seed={seed} step={steps} result={result:?}");
                let Ok(outcome) = result else {
                    seen.rejected += 1;
                    assert_eq!(g, before, "a rejected command changed state: {context}");
                    continue;
                };
                check_state(&g, &context);
                check_step(&before, &g, &outcome, &context);

                heals += usize::from(before.heal_available() && !g.heal_available());
                poisons += usize::from(before.poison_available() && !g.poison_available());
                let witch_just_acted = before.pending_actors() == living_role(&before, X)
                    && before.phase() == Phase::Night
                    && !before.pending_actors().is_empty()
                    && g.pending_actors().is_empty()
                    && outcome.is_none();
                if witch_just_acted && before.heal_available() == g.heal_available() {
                    seen.passes += usize::from(before.poison_available() == g.poison_available());
                }
                match &outcome {
                    Some(NightOutcome::AwaitingWitch) => seen.witch_turns += 1,
                    Some(NightOutcome::Dawn { deaths, .. }) => {
                        seen.double_deaths += usize::from(deaths.len() == 2);
                        seen.hunter_pauses_at_night += usize::from(g.phase() == Phase::Hunter);
                        // A dawn straight from the pack's choice means the witch was skipped.
                        let skipped = before.witch_victim().is_none()
                            && before.pending_actors().is_empty()
                            && before.current_night_picks().len() == living_role(&before, W).len()
                            && !(before.heal_available() || before.poison_available())
                            && !living_role(&before, X).is_empty();
                        seen.skipped_turns += usize::from(skipped);
                    }
                    _ => {}
                }
            }
            assert!(heals <= 1 && poisons <= 1, "roles={roles:?} seed={seed}");
            seen.heals += heals;
            seen.poisons += poisons;
            match g.winner().unwrap() {
                Winner::Villagers => seen.villager_wins += 1,
                Winner::Werewolves => seen.werewolf_wins += 1,
            }
        }
    }
    assert!(seen.rejected > 10_000, "rejected {}", seen.rejected);
    for (name, count) in [
        ("heals", seen.heals),
        ("poisons", seen.poisons),
        ("passes", seen.passes),
        ("double deaths", seen.double_deaths),
        ("witch turns", seen.witch_turns),
        ("skipped turns", seen.skipped_turns),
        ("hunter pauses at night", seen.hunter_pauses_at_night),
        ("villager wins", seen.villager_wins),
        ("werewolf wins", seen.werewolf_wins),
    ] {
        assert!(count > 20, "the fuzz reached {name} only {count} times");
    }
}
