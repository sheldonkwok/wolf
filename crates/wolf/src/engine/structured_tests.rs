//! Unit tests for the 12-player structured rules: the fixed deal, the sheriff election and weighted vote, the Fool, and Night 1 last words.

use super::*;
use Role::{Fool as F, Villager as V, Werewolf as W};

/// Seats follow [`Engine::STRUCTURED_ROLES`]: P0-P3 wolves, P4-P7 villagers, P8 seer, P9 witch, P10 hunter, P11 fool.
const SEER: PlayerId = PlayerId(8);
const WITCH: PlayerId = PlayerId(9);
const FOOL: PlayerId = PlayerId(11);

fn p(index: usize) -> PlayerId {
    PlayerId(index)
}

fn structured() -> Engine {
    Engine::with_ruleset(&Engine::STRUCTURED_ROLES, Ruleset::Structured).unwrap()
}

/// A structured Day 1 with `sheriff` already holding the badge.
fn day_one(sheriff: Option<PlayerId>) -> Engine {
    let mut g = structured();
    g.phase = Phase::Day;
    g.sheriff = sheriff;
    g
}

fn living(g: &Engine) -> Vec<PlayerId> {
    g.alive().map(|p| p.id()).collect()
}

/// Every living werewolf names `target`, the witch passes if asked, and the night resolves.
fn wolves_kill(g: &mut Engine, target: PlayerId, witch: WitchChoice) -> NightOutcome {
    for wolf in g.living_ids_where(|p| p.role() == W) {
        g.night_action(wolf, target).unwrap();
    }
    if g.is_alive(SEER) {
        g.seer_action(SEER, SEER).unwrap();
    }
    if g.resolve_night().unwrap() == NightOutcome::AwaitingWitch {
        g.witch_action(WITCH, witch).unwrap();
    }
    g.resolve_night().unwrap()
}

/// Every eligible voter votes for `target`, then the day resolves.
fn town_votes(g: &mut Engine, target: PlayerId) -> DayOutcome {
    for voter in g.pending_actors() {
        g.vote(voter, target).unwrap();
    }
    g.resolve_day().unwrap()
}

#[test]
fn twelve_players_always_get_the_structured_roster() {
    let mut expected = Engine::STRUCTURED_ROLES.to_vec();
    expected.sort_by_key(|r| *r as u8);
    for seed in 0..100 {
        let g = Engine::with_seed(12, seed).unwrap();
        let mut roles: Vec<_> = g.players().iter().map(|p| p.role()).collect();
        roles.sort_by_key(|r| *r as u8);
        assert_eq!(roles, expected, "seed={seed}");
        assert_eq!(g.ruleset(), Ruleset::Structured);
        assert_eq!(g.phase(), Phase::Sheriff);
        assert_eq!(g.round(), 1);
        assert_eq!(g.alive_count_by_role(), (8, 4));
    }
    for players in [5, 11, 13] {
        let g = Engine::with_seed(players, 7).unwrap();
        assert_eq!(g.ruleset(), Ruleset::Standard);
        assert!(g.players().iter().all(|p| p.role() != F));
    }
}

#[test]
fn structured_rosters_must_match_exactly() {
    let mut roles = Engine::STRUCTURED_ROLES;
    roles[11] = V;
    assert!(matches!(
        Engine::with_ruleset(&roles, Ruleset::Structured),
        Err(GameError::InvalidRoster(_))
    ));
    assert!(matches!(
        Engine::with_ruleset(&[W, V, V, V, V], Ruleset::Structured),
        Err(GameError::InvalidRoster(_))
    ));
    assert!(matches!(
        Engine::with_roles(&[W, F, F, V, V]),
        Err(GameError::InvalidRoster(_))
    ));
    let g = Engine::with_roles(&Engine::STRUCTURED_ROLES).unwrap();
    assert_eq!(g.ruleset(), Ruleset::Standard);
    assert_eq!(g.phase(), Phase::Day);
}

#[test]
fn sheriff_election_elects_an_early_majority() {
    let mut g = structured();
    assert_eq!(g.pending_actors(), living(&g));
    assert_eq!(g.pending_inspectors(), Vec::new());
    assert_eq!(g.majority_required(), 7);
    assert_eq!(
        g.vote(p(0), p(1)),
        Err(GameError::WrongPhase {
            expected: Phase::Day,
            actual: Phase::Sheriff
        })
    );
    assert!(matches!(
        g.seer_action(SEER, p(0)),
        Err(GameError::WrongPhase { .. })
    ));
    assert_eq!(g.resolve_sheriff(), Err(GameError::NoMajority));
    for voter in 0..7 {
        g.sheriff_vote(p(voter), p(5)).unwrap();
    }
    g.sheriff_vote(p(6), p(4)).unwrap();
    assert_eq!(g.majority_target(), None);
    assert_eq!(g.current_sheriff_votes().len(), 7);
    g.sheriff_vote(p(7), p(5)).unwrap();
    assert_eq!(g.majority_target(), Some(p(5)));
    assert_eq!(g.resolve_sheriff(), Ok(SheriffOutcome::Elected(p(5))));
    assert_eq!(g.sheriff(), Some(p(5)));
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.round(), 1);
    assert_eq!(g.pending_inspectors(), vec![SEER]);
    assert!(g.current_sheriff_votes().is_empty());
    assert!(matches!(
        g.sheriff_vote(p(0), p(1)),
        Err(GameError::WrongPhase { .. })
    ));
}

#[test]
fn sheriff_election_uses_a_plurality_and_a_tie_leaves_no_sheriff() {
    let mut g = structured();
    for voter in 0..12 {
        g.sheriff_vote(p(voter), p(voter % 3)).unwrap();
    }
    g.sheriff_vote(p(2), p(0)).unwrap();
    assert_eq!(g.resolve_sheriff(), Ok(SheriffOutcome::Elected(p(0))));

    let mut g = structured();
    for voter in 0..12 {
        g.sheriff_vote(p(voter), p(voter % 2)).unwrap();
    }
    assert_eq!(g.resolve_sheriff(), Ok(SheriffOutcome::Tied));
    assert_eq!(g.sheriff(), None);
    assert_eq!(g.phase(), Phase::Day);
    assert!(living(&g).iter().all(|&id| g.vote_weight(id) == 1.0));
}

#[test]
fn sheriff_vote_counts_one_and_a_half() {
    let sheriff = p(4);
    let mut g = day_one(Some(sheriff));
    assert_eq!(g.vote_weight(sheriff), 1.5);
    assert_eq!(g.vote_weight(p(5)), 1.0);
    assert_eq!(g.majority_required(), 7);
    for voter in [4, 5, 6, 7, 8, 9] {
        g.vote(p(voter), p(0)).unwrap();
    }
    assert_eq!(g.majority_target(), None, "6.5 votes is short of 7");
    g.vote(p(10), p(0)).unwrap();
    assert_eq!(g.majority_target(), Some(p(0)));

    // A complete 6-6 split goes to the sheriff's side.
    let mut g = day_one(Some(sheriff));
    for voter in 0..12 {
        let target = if voter < 6 { p(4) } else { p(0) };
        g.vote(p(voter), target).unwrap();
    }
    g.vote(sheriff, p(0)).unwrap();
    g.vote(p(6), p(4)).unwrap();
    assert_eq!(g.resolve_day(), Ok(DayOutcome::Eliminated(p(0))));
}

#[test]
fn badge_is_lost_when_the_sheriff_dies() {
    let mut g = day_one(Some(p(4)));
    assert_eq!(town_votes(&mut g, p(4)), DayOutcome::Eliminated(p(4)));
    assert_eq!(g.sheriff(), None);
    assert_eq!(g.phase(), Phase::Night);
    assert!(living(&g).iter().all(|&id| g.vote_weight(id) == 1.0));
}

#[test]
fn voted_out_fool_survives_without_a_vote_until_voted_out_again() {
    let mut g = day_one(Some(FOOL));
    assert_eq!(town_votes(&mut g, FOOL), DayOutcome::FoolRevealed(FOOL));
    assert!(g.is_alive(FOOL));
    assert_eq!(g.revealed_fool(), Some(FOOL));
    assert_eq!(g.sheriff(), None, "a revealed fool loses the badge");
    assert_eq!(g.phase(), Phase::Night);
    assert!(!g.can_vote(FOOL));

    assert_eq!(
        wolves_kill(&mut g, p(4), WitchChoice::Pass),
        NightOutcome::Dawn {
            saved: None,
            deaths: vec![p(4)],
        }
    );
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.vote(FOOL, p(0)), Err(GameError::CannotVote(FOOL)));
    assert!(!g.pending_actors().contains(&FOOL));
    assert_eq!(g.majority_required(), 6, "ten eligible voters");
    assert_eq!(town_votes(&mut g, FOOL), DayOutcome::Eliminated(FOOL));
    assert!(!g.is_alive(FOOL));
}

#[test]
fn fool_dies_normally_at_night() {
    let mut g = day_one(None);
    town_votes(&mut g, p(4));
    assert_eq!(
        wolves_kill(&mut g, FOOL, WitchChoice::Pass),
        NightOutcome::Dawn {
            saved: None,
            deaths: vec![FOOL],
        }
    );
    assert!(!g.is_alive(FOOL));
    assert_eq!(g.revealed_fool(), None);
}

#[test]
fn night_one_victims_get_last_words_until_day_two_ends() {
    let mut g = day_one(None);
    town_votes(&mut g, p(0));
    assert_eq!(
        g.pending_last_words(),
        Vec::new(),
        "a day elimination has none"
    );
    let outcome = wolves_kill(&mut g, p(5), WitchChoice::Poison(p(6)));
    assert_eq!(
        outcome,
        NightOutcome::Dawn {
            saved: None,
            deaths: vec![p(5), p(6)],
        }
    );
    assert_eq!(g.pending_last_words(), vec![p(5), p(6)]);
    assert_eq!(g.last_words(p(7)), Err(GameError::NoLastWords(p(7))));
    assert_eq!(g.last_words(p(5)), Ok(()));
    assert_eq!(g.last_words(p(5)), Err(GameError::NoLastWords(p(5))));
    assert_eq!(g.pending_last_words(), vec![p(6)]);

    town_votes(&mut g, p(1));
    assert_eq!(
        g.pending_last_words(),
        Vec::new(),
        "unused last words expire"
    );
    assert_eq!(g.last_words(p(6)), Err(GameError::NoLastWords(p(6))));
    wolves_kill(&mut g, SEER, WitchChoice::Pass);
    assert_eq!(g.round(), 3);
    assert_eq!(
        g.pending_last_words(),
        Vec::new(),
        "only Night 1 grants last words"
    );
}

#[test]
fn standard_games_grant_no_last_words() {
    let mut g = Engine::with_roles(&Engine::STRUCTURED_ROLES).unwrap();
    town_votes(&mut g, p(4));
    wolves_kill(&mut g, p(5), WitchChoice::Pass);
    assert_eq!(g.pending_last_words(), Vec::new());
}
