//! Unit tests for the 12-player structured rules: the fixed deal, the night-first order, the sheriff election and badge, the Fool, the silenced Hunter, and Night 1 last words.

use super::*;
use Role::{Fool as F, Villager as V, Werewolf as W};

/// Seats follow [`Engine::STRUCTURED_ROLES`]: P0-P3 wolves, P4-P7 villagers, P8 seer, P9 witch, P10 hunter, P11 fool.
const SEER: PlayerId = PlayerId(8);
const WITCH: PlayerId = PlayerId(9);
const HUNTER: PlayerId = PlayerId(10);
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

/// Every living werewolf names `target`, the seer looks at themselves, the witch makes `witch`, and the night resolves.
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

/// Every living player declares, with only `candidates` running.
fn declare(g: &mut Engine, candidates: &[usize]) {
    for player in living(g) {
        g.sheriff_nominate(player, candidates.contains(&player.index()))
            .unwrap();
    }
}

/// Night 1 kills `target`, `candidates` run, and every voter backs `pick`.
fn opening(target: PlayerId, candidates: &[usize], pick: PlayerId) -> (Engine, Election) {
    let mut g = structured();
    assert_eq!(
        wolves_kill(&mut g, target, WitchChoice::Pass),
        NightOutcome::Election
    );
    declare(&mut g, candidates);
    for voter in g.pending_actors() {
        g.sheriff_vote(voter, pick).unwrap();
    }
    let election = g.resolve_sheriff().unwrap();
    (g, election)
}

/// Every eligible voter votes for `target`, then the day resolves.
fn town_votes(g: &mut Engine, target: PlayerId) -> DayOutcome {
    for voter in g.pending_actors() {
        g.vote(voter, target).unwrap();
    }
    g.resolve_day().unwrap()
}

#[test]
fn twelve_players_always_get_the_structured_roster_and_open_at_night() {
    let mut expected = Engine::STRUCTURED_ROLES.to_vec();
    expected.sort_by_key(|r| *r as u8);
    for seed in 0..100 {
        let g = Engine::with_seed(12, seed).unwrap();
        let mut roles: Vec<_> = g.players().iter().map(|p| p.role()).collect();
        roles.sort_by_key(|r| *r as u8);
        assert_eq!(roles, expected, "seed={seed}");
        assert_eq!(g.ruleset(), Ruleset::Structured);
        assert_eq!(g.phase(), Phase::Night);
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
fn the_election_comes_before_the_night_one_report_and_only_non_candidates_vote() {
    let mut g = structured();
    assert_eq!(g.pending_inspectors(), vec![SEER]);
    let night = wolves_kill(&mut g, p(5), WitchChoice::Poison(p(6)));
    assert_eq!(night, NightOutcome::Election);
    assert_eq!(g.phase(), Phase::Sheriff);
    assert_eq!(g.round(), 1);
    assert!(
        g.is_alive(p(5)) && g.is_alive(p(6)),
        "deaths wait for the report"
    );
    assert_eq!(g.pending_last_words(), Vec::new());
    assert_eq!(
        g.pending_actors(),
        living(&g),
        "tonight's victims still take part"
    );
    assert!(!g.sheriff_voting());
    assert_eq!(g.sheriff_vote(p(0), p(4)), Err(GameError::NominationsOpen));
    assert_eq!(g.sheriff_withdraw(p(4)), Err(GameError::NominationsOpen));
    assert!(matches!(
        g.resolve_sheriff(),
        Err(GameError::ActionsIncomplete { .. })
    ));
    assert!(matches!(
        g.vote(p(0), p(1)),
        Err(GameError::WrongPhase { .. })
    ));

    g.sheriff_nominate(p(4), false).unwrap();
    g.sheriff_nominate(p(4), true).unwrap();
    declare(&mut g, &[4, 6]);
    assert!(g.sheriff_voting());
    assert_eq!(g.sheriff_candidates(), vec![p(4), p(6)]);
    assert_eq!(
        g.sheriff_nominate(p(0), true),
        Err(GameError::NominationsClosed)
    );
    assert_eq!(g.sheriff_vote(p(4), p(6)), Err(GameError::CannotVote(p(4))));
    assert_eq!(
        g.sheriff_vote(p(0), p(1)),
        Err(GameError::NotACandidate(p(1)))
    );
    assert!(!g.can_vote(p(6)) && g.can_vote(p(5)));
    assert_eq!(g.majority_required(), 6, "ten voters");
    for voter in [0, 1, 2, 3, 5] {
        g.sheriff_vote(p(voter), p(4)).unwrap();
    }
    assert_eq!(g.majority_target(), None);
    assert_eq!(g.resolve_sheriff(), Err(GameError::NoMajority));
    g.sheriff_vote(p(7), p(4)).unwrap();
    assert_eq!(g.majority_target(), Some(p(4)));

    assert_eq!(
        g.resolve_sheriff(),
        Ok(Election {
            outcome: SheriffOutcome::Elected(p(4)),
            saved: None,
            deaths: vec![p(5), p(6)],
        })
    );
    assert!(!g.is_alive(p(5)) && !g.is_alive(p(6)));
    assert_eq!(g.sheriff(), Some(p(4)));
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.round(), 1);
    assert_eq!(g.pending_last_words(), vec![p(5), p(6)]);
    assert_eq!(g.pending_inspectors(), Vec::new(), "no daytime inspection");
    assert!(g.current_sheriff_votes().is_empty());
    assert!(g.sheriff_nominations().is_empty());
}

#[test]
fn lone_candidates_win_unopposed_and_empty_fields_leave_no_sheriff() {
    let (g, election) = opening(p(4), &[7], p(7));
    assert_eq!(election.outcome, SheriffOutcome::Elected(p(7)));
    assert_eq!(g.sheriff(), Some(p(7)));

    let (g, election) = opening(p(4), &[], p(7));
    assert_eq!(election.outcome, SheriffOutcome::Tied);
    assert_eq!(g.sheriff(), None);

    let all: Vec<usize> = (0..12).collect();
    let (_, election) = opening(p(4), &all, p(7));
    assert_eq!(
        election.outcome,
        SheriffOutcome::Tied,
        "nobody is left to vote"
    );
}

#[test]
fn a_withdrawn_candidate_loses_their_votes_and_cannot_vote() {
    let mut g = structured();
    wolves_kill(&mut g, p(4), WitchChoice::Pass);
    declare(&mut g, &[5, 6, 7]);
    g.sheriff_vote(p(0), p(6)).unwrap();
    g.sheriff_vote(p(1), p(5)).unwrap();
    assert_eq!(
        g.sheriff_withdraw(p(0)),
        Err(GameError::NotACandidate(p(0)))
    );
    g.sheriff_withdraw(p(6)).unwrap();
    assert_eq!(
        g.sheriff_withdraw(p(6)),
        Err(GameError::NotACandidate(p(6)))
    );
    assert_eq!(g.current_sheriff_votes().len(), 1);
    assert_eq!(g.sheriff_vote(p(6), p(5)), Err(GameError::CannotVote(p(6))));
    assert_eq!(
        g.sheriff_vote(p(2), p(6)),
        Err(GameError::NotACandidate(p(6)))
    );
    g.sheriff_withdraw(p(7)).unwrap();
    assert_eq!(g.pending_actors(), Vec::new(), "one candidate is left");
    let election = g.resolve_sheriff().unwrap();
    assert_eq!(election.outcome, SheriffOutcome::Elected(p(5)));
}

#[test]
fn sheriff_election_uses_a_plurality_and_a_tie_leaves_no_sheriff() {
    let mut g = structured();
    wolves_kill(&mut g, p(4), WitchChoice::Pass);
    declare(&mut g, &[0, 1, 2]);
    for voter in 3..12 {
        g.sheriff_vote(p(voter), p(voter % 3)).unwrap();
    }
    g.sheriff_vote(p(5), p(0)).unwrap();
    assert_eq!(
        g.resolve_sheriff().unwrap().outcome,
        SheriffOutcome::Elected(p(0))
    );

    let mut g = structured();
    wolves_kill(&mut g, p(4), WitchChoice::Pass);
    declare(&mut g, &[0, 1]);
    for voter in 2..12 {
        g.sheriff_vote(p(voter), p(voter % 2)).unwrap();
    }
    assert_eq!(g.resolve_sheriff().unwrap().outcome, SheriffOutcome::Tied);
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
fn a_sheriff_killed_on_night_one_passes_the_badge_after_the_election() {
    let (mut g, election) = opening(p(5), &[5, 6], p(5));
    assert_eq!(election.outcome, SheriffOutcome::Elected(p(5)));
    assert_eq!(election.deaths, vec![p(5)]);
    assert_eq!(g.phase(), Phase::Badge);
    assert_eq!(g.pending_actors(), vec![p(5)]);
    assert_eq!(g.sheriff(), None, "a dead sheriff's vote never counts");
    assert_eq!(
        g.pass_badge(p(6), Some(p(7))),
        Err(GameError::NotTheSheriff(p(6)))
    );
    assert_eq!(
        g.pass_badge(p(5), Some(p(5))),
        Err(GameError::PlayerNotAlive(p(5)))
    );
    g.pass_badge(p(5), Some(p(7))).unwrap();
    assert_eq!(g.sheriff(), Some(p(7)));
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.round(), 1);
}

#[test]
fn a_voted_out_sheriff_may_tear_up_the_badge() {
    let mut g = day_one(Some(p(4)));
    assert_eq!(town_votes(&mut g, p(4)), DayOutcome::Eliminated(p(4)));
    assert_eq!(g.phase(), Phase::Badge);
    g.pass_badge(p(4), None).unwrap();
    assert_eq!(g.sheriff(), None);
    assert_eq!(g.phase(), Phase::Night);
    assert_eq!(g.round(), 2, "structured rounds count Night N then Day N");
    assert_eq!(
        g.pass_badge(p(4), None),
        Err(GameError::WrongPhase {
            expected: Phase::Badge,
            actual: Phase::Night
        })
    );
    assert!(living(&g).iter().all(|&id| g.vote_weight(id) == 1.0));
}

#[test]
fn a_hunter_sheriff_shoots_before_passing_the_badge() {
    let mut g = day_one(Some(HUNTER));
    town_votes(&mut g, HUNTER);
    assert_eq!(g.phase(), Phase::Hunter);
    g.hunter_action(HUNTER, p(0)).unwrap();
    assert_eq!(g.phase(), Phase::Badge);
    g.pass_badge(HUNTER, Some(p(4))).unwrap();
    assert_eq!(g.phase(), Phase::Night);
    assert_eq!(g.sheriff(), Some(p(4)));
}

#[test]
fn a_poisoned_hunter_cannot_shoot_but_an_attacked_one_can() {
    let mut g = day_one(None);
    town_votes(&mut g, p(4));
    let night = wolves_kill(&mut g, p(5), WitchChoice::Poison(HUNTER));
    assert_eq!(
        night,
        NightOutcome::Dawn {
            saved: None,
            deaths: vec![p(5), HUNTER],
        }
    );
    assert_eq!(g.phase(), Phase::Day, "no shot for a poisoned hunter");

    let mut g = day_one(None);
    town_votes(&mut g, p(4));
    wolves_kill(&mut g, HUNTER, WitchChoice::Pass);
    assert_eq!(g.phase(), Phase::Hunter);

    let mut g = structured();
    wolves_kill(&mut g, p(5), WitchChoice::Poison(HUNTER));
    declare(&mut g, &[]);
    g.resolve_sheriff().unwrap();
    assert_eq!(
        g.phase(),
        Phase::Day,
        "Night 1 poison also silences the hunter"
    );
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
    assert_eq!(g.round(), 2);
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
fn night_one_victims_get_last_words_until_day_one_ends() {
    let mut g = structured();
    wolves_kill(&mut g, p(5), WitchChoice::Poison(p(0)));
    declare(&mut g, &[]);
    g.resolve_sheriff().unwrap();
    assert_eq!(
        g.pending_last_words(),
        vec![p(0), p(5)],
        "wolves get last words too"
    );
    assert_eq!(g.last_words(p(7)), Err(GameError::NoLastWords(p(7))));
    assert_eq!(g.last_words(p(5)), Ok(()));
    assert_eq!(g.last_words(p(5)), Err(GameError::NoLastWords(p(5))));
    assert_eq!(g.pending_last_words(), vec![p(0)]);

    town_votes(&mut g, p(1));
    assert_eq!(
        g.pending_last_words(),
        Vec::new(),
        "unused last words expire"
    );
    assert_eq!(g.last_words(p(0)), Err(GameError::NoLastWords(p(0))));
    assert_eq!(g.round(), 2);
    wolves_kill(&mut g, SEER, WitchChoice::Pass);
    assert_eq!(g.phase(), Phase::Day);
    assert_eq!(g.round(), 2);
    assert_eq!(
        g.pending_last_words(),
        Vec::new(),
        "only Night 1 grants last words"
    );
}

#[test]
fn standard_games_keep_their_day_first_rules() {
    let mut g = Engine::with_roles(&Engine::STRUCTURED_ROLES).unwrap();
    assert_eq!(g.pending_inspectors(), vec![SEER]);
    town_votes(&mut g, p(4));
    wolves_kill(&mut g, p(5), WitchChoice::Poison(HUNTER));
    assert_eq!(g.pending_last_words(), Vec::new());
    assert_eq!(
        g.phase(),
        Phase::Hunter,
        "a standard poisoned hunter still shoots"
    );
}
