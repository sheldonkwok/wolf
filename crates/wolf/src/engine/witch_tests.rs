//! Exhaustive single-night checks for the witch: every attack, protection, potion state, and choice is compared with an independent oracle.

use super::*;
use Role::{Doctor as D, Hunter as H, Seer as S, Villager as V, Werewolf as W, Witch as X};

/// Which interesting corners of the night the sweep actually reached.
#[derive(Default)]
struct Seen {
    cases: usize,
    two_deaths: bool,
    saved_with_a_poison_death: bool,
    redundant_heal: bool,
    self_heal: bool,
    hunter_pause: bool,
    villagers_win: bool,
    werewolves_win: bool,
    game_continues: bool,
    no_turn: bool,
}

/// A Night 1 table with `dead` seats already eliminated and the given potions left.
fn table(roles: &[Role], dead: &[usize], heal: bool, poison: bool) -> Engine {
    let mut g = Engine::with_roles(roles).expect("roster should be valid");
    for &seat in dead {
        g.players[seat].kill();
    }
    g.phase = Phase::Night;
    g.heal_used = !heal;
    g.poison_used = !poison;
    g
}

fn living_with(g: &Engine, role: Role) -> Vec<PlayerId> {
    g.living_ids_where(|p| p.role() == role)
}

/// The error the rules demand for `choice`, or `None` when the witch may make it.
fn rejection(
    g: &Engine,
    witch: PlayerId,
    choice: WitchChoice,
    heal: bool,
    poison: bool,
) -> Option<GameError> {
    match choice {
        WitchChoice::Pass => None,
        WitchChoice::Heal => (!heal).then_some(GameError::PotionSpent(witch)),
        WitchChoice::Poison(target) if target.index() >= g.players().len() => {
            Some(GameError::UnknownPlayer(target))
        }
        WitchChoice::Poison(target) if !g.is_alive(target) => {
            Some(GameError::PlayerNotAlive(target))
        }
        WitchChoice::Poison(target) if target == witch => Some(GameError::WitchCannotPoisonSelf),
        WitchChoice::Poison(_) => (!poison).then_some(GameError::PotionSpent(witch)),
    }
}

/// Play one night for every combination on this table and check the engine against the rules.
fn sweep(roles: &[Role], dead: &[usize], seen: &mut Seen) {
    let base = table(roles, dead, true, true);
    let living: Vec<PlayerId> = base.alive().map(|p| p.id()).collect();
    let wolves = living_with(&base, W);
    let doctor = living_with(&base, D).first().copied();
    let seer = living_with(&base, S).first().copied();
    let witch = living_with(&base, X).first().copied();
    let protections: Vec<Option<PlayerId>> = match doctor {
        Some(_) => living.iter().copied().map(Some).collect(),
        None => vec![None],
    };
    let mut choices = vec![WitchChoice::Heal, WitchChoice::Pass];
    choices.extend((0..=roles.len()).map(|seat| WitchChoice::Poison(PlayerId(seat))));

    for (heal, poison) in [(true, true), (true, false), (false, true), (false, false)] {
        for &attack in &living {
            if wolves.len() == 1 && attack == wolves[0] {
                continue;
            }
            for &protect in &protections {
                for &choice in &choices {
                    seen.cases += 1;
                    let mut g = table(roles, dead, heal, poison);
                    for &wolf in &wolves {
                        g.night_action(wolf, attack).unwrap();
                    }
                    if let Some(doctor) = doctor {
                        g.doctor_action(doctor, protect.unwrap()).unwrap();
                    }
                    if let Some(seer) = seer {
                        g.seer_action(seer, attack).unwrap();
                    }

                    // The witch's turn exists only for a living witch with a potion left.
                    let turn = witch.filter(|_| heal || poison);
                    let applied = match turn {
                        None => {
                            seen.no_turn = true;
                            if let Some(witch) = witch {
                                let before = g.clone();
                                assert_eq!(
                                    g.witch_action(witch, choice),
                                    Err(GameError::PackUndecided)
                                );
                                assert_eq!(g, before);
                            }
                            WitchChoice::Pass
                        }
                        Some(witch) => {
                            assert_eq!(g.resolve_night(), Ok(NightOutcome::AwaitingWitch));
                            assert_eq!(g.phase(), Phase::Night);
                            assert_eq!(g.round(), 1);
                            assert_eq!(g.pending_actors(), vec![witch]);
                            assert_eq!(g.witch_victim(), heal.then_some(attack));
                            assert_eq!(g.alive().count(), living.len());

                            let before = g.clone();
                            if let Some(error) = rejection(&g, witch, choice, heal, poison) {
                                assert_eq!(g.witch_action(witch, choice), Err(error));
                                assert_eq!(g, before);
                                continue;
                            }
                            g.witch_action(witch, choice).unwrap();
                            assert_eq!(g.pending_actors(), Vec::new());
                            assert_eq!(g.witch_victim(), None);
                            assert_eq!(g.alive().count(), living.len());
                            choice
                        }
                    };

                    // The oracle: the attack lands unless protected or healed, and poison always lands.
                    let protected = protect == Some(attack);
                    let healed = applied == WitchChoice::Heal;
                    let mut deaths = BTreeSet::new();
                    if !protected && !healed {
                        deaths.insert(attack);
                    }
                    if let WitchChoice::Poison(target) = applied {
                        deaths.insert(target);
                    }
                    let saved = (!deaths.contains(&attack)).then_some(attack);
                    let expected = NightOutcome::Dawn {
                        saved,
                        deaths: deaths.iter().copied().collect(),
                    };
                    let context = format!(
                        "roles={roles:?} dead={dead:?} potions=({heal},{poison}) attack={attack} protect={protect:?} choice={choice:?}"
                    );
                    assert_eq!(g.resolve_night(), Ok(expected), "{context}");

                    for &id in &living {
                        assert_eq!(g.is_alive(id), !deaths.contains(&id), "{context}");
                    }
                    assert_eq!(g.heal_available(), heal && !healed, "{context}");
                    assert_eq!(
                        g.poison_available(),
                        poison && !matches!(applied, WitchChoice::Poison(_)),
                        "{context}"
                    );
                    assert_eq!(g.witch_victim(), None);
                    assert!(g.current_night_picks().is_empty());
                    assert!(g.current_doctor_picks().is_empty());

                    let hunter = deaths.iter().copied().find(|id| g.role_of(*id) == Ok(H));
                    let (villagers, wolves_left) = g.alive_count_by_role();
                    if let Some(hunter) = hunter {
                        seen.hunter_pause = true;
                        assert_eq!(g.phase(), Phase::Hunter, "{context}");
                        assert_eq!(g.winner(), None, "{context}");
                        assert_eq!(g.round(), 1);
                        assert_eq!(g.pending_actors(), vec![hunter]);
                    } else if wolves_left == 0 {
                        seen.villagers_win = true;
                        assert_eq!(g.phase(), Phase::Ended, "{context}");
                        assert_eq!(g.winner(), Some(Winner::Villagers), "{context}");
                    } else if wolves_left >= villagers {
                        seen.werewolves_win = true;
                        assert_eq!(g.phase(), Phase::Ended, "{context}");
                        assert_eq!(g.winner(), Some(Winner::Werewolves), "{context}");
                    } else {
                        seen.game_continues = true;
                        assert_eq!(g.phase(), Phase::Day, "{context}");
                        assert_eq!(g.round(), 2);
                        assert_eq!(g.winner(), None);
                        assert_eq!(g.pending_actors().len(), living.len() - deaths.len());
                    }

                    seen.two_deaths |= deaths.len() == 2;
                    seen.saved_with_a_poison_death |= saved.is_some() && !deaths.is_empty();
                    seen.redundant_heal |= protected && healed;
                    seen.self_heal |= healed && Some(attack) == witch;
                }
            }
        }
    }
}

#[test]
fn every_single_night_matches_the_rules() {
    let mut seen = Seen::default();
    // Full tables, shrinking tables near parity, and tables whose witch is already dead.
    for (roles, dead) in [
        (&[W, X, D, H, S, V, V][..], &[][..]),
        (&[W, W, X, H, V, V, V], &[]),
        (&[W, W, X, D, V, V, V, V], &[]),
        (&[W, X, H, V, V], &[4]),
        (&[W, X, V, V, V], &[3, 4]),
        (&[W, X, D, V, V], &[4]),
        (&[W, X, D, H, V], &[]),
        (&[W, X, D, V, V], &[1]),
        (&[W, X, H, V, V, V], &[1]),
    ] {
        sweep(roles, dead, &mut seen);
    }
    assert!(seen.cases > 5_000, "only {} cases", seen.cases);
    assert!(seen.two_deaths);
    assert!(seen.saved_with_a_poison_death);
    assert!(seen.redundant_heal);
    assert!(seen.self_heal);
    assert!(seen.hunter_pause);
    assert!(seen.villagers_win);
    assert!(seen.werewolves_win);
    assert!(seen.game_continues);
    assert!(seen.no_turn);
}
