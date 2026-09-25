use Role::{Doctor, Hunter, Villager, Werewolf};
use wolf::{Engine, GameError, Phase, PlayerId, Role, Winner};

fn eliminate(g: &mut Engine, target: usize) {
    let voters: Vec<_> = g.alive().map(|p| p.id()).collect();
    for voter in voters {
        g.vote(voter, PlayerId(target)).unwrap();
    }
    g.resolve_day().unwrap();
}

#[test]
fn hunter_defers_parity_and_can_win_with_a_final_shot() {
    let mut g = Engine::with_roles(&[Werewolf, Hunter, Villager, Villager, Villager]).unwrap();
    eliminate(&mut g, 4);
    g.night_action(PlayerId(0), PlayerId(3)).unwrap();
    g.resolve_night().unwrap();
    eliminate(&mut g, 1);
    assert_eq!(g.phase(), Phase::Hunter);
    assert_eq!(g.winner(), None);
    assert_eq!(g.pending_actors(), vec![PlayerId(1)]);
    assert!(!g.is_alive(PlayerId(1)));
    let before = g.clone();
    for (actor, target, error) in [
        (0, 2, GameError::NotPendingHunter(PlayerId(0))),
        (99, 2, GameError::UnknownPlayer(PlayerId(99))),
        (1, 99, GameError::UnknownPlayer(PlayerId(99))),
        (1, 1, GameError::PlayerNotAlive(PlayerId(1))),
        (1, 4, GameError::PlayerNotAlive(PlayerId(4))),
    ] {
        assert_eq!(
            g.hunter_action(PlayerId(actor), PlayerId(target)),
            Err(error)
        );
        assert_eq!(g, before);
    }
    assert!(g.vote(PlayerId(2), PlayerId(0)).is_err());
    assert!(g.resolve_day().is_err());
    assert!(g.resolve_night().is_err());
    g.hunter_action(PlayerId(1), PlayerId(0)).unwrap();
    assert_eq!(g.winner(), Some(Winner::Villagers));
    assert_eq!(
        g.hunter_action(PlayerId(1), PlayerId(2)),
        Err(GameError::GameOver)
    );
}

#[test]
fn hunter_resumes_the_correct_phase_and_round() {
    for night in [false, true] {
        let mut g = Engine::with_roles(&[Werewolf, Hunter, Villager, Villager, Villager, Villager])
            .unwrap();
        assert!(g.hunter_action(PlayerId(1), PlayerId(0)).is_err());
        if night {
            eliminate(&mut g, 5);
            g.night_action(PlayerId(0), PlayerId(1)).unwrap();
            g.resolve_night().unwrap();
        } else {
            eliminate(&mut g, 1);
        }
        assert_eq!(g.phase(), Phase::Hunter);
        assert_eq!(g.round(), 1);
        g.hunter_action(PlayerId(1), PlayerId(2)).unwrap();
        assert_eq!(g.phase(), if night { Phase::Day } else { Phase::Night });
        assert_eq!(g.round(), if night { 2 } else { 1 });
        let before = g.clone();
        assert!(g.hunter_action(PlayerId(1), PlayerId(3)).is_err());
        assert_eq!(g, before);
    }
}

#[test]
fn saved_hunter_has_no_shot_and_shooting_an_innocent_can_lose() {
    let mut g = Engine::with_roles(&[Werewolf, Hunter, Doctor, Villager, Villager]).unwrap();
    eliminate(&mut g, 4);
    g.night_action(PlayerId(0), PlayerId(1)).unwrap();
    g.doctor_action(PlayerId(2), PlayerId(1)).unwrap();
    g.resolve_night().unwrap();
    assert_eq!(g.phase(), Phase::Day);
    assert!(g.is_alive(PlayerId(1)));
    eliminate(&mut g, 1);
    g.hunter_action(PlayerId(1), PlayerId(2)).unwrap();
    assert_eq!(g.winner(), Some(Winner::Werewolves));
}

#[test]
fn deals_include_exactly_one_hunter_and_duplicates_are_rejected() {
    for count in 5..=20 {
        let g = Engine::with_seed(count, 42).unwrap();
        assert_eq!(g.players().iter().filter(|p| p.role() == Hunter).count(), 1);
    }
    assert!(Engine::with_roles(&[Werewolf, Hunter, Hunter, Villager, Villager]).is_err());
}
