//! An interactive werewolf CLI: you take one seat at a table of bots and play the engine by hand.

use std::collections::BTreeMap;
use std::io::{self, Write};

use wolf::rng::{self, SplitMix64};
use wolf::{DayOutcome, Engine, NightOutcome, Phase, PlayerId, Role, Winner};

/// Friendly seat names; seats past the table fall back to `P{n}`.
const NAMES: [&str; 16] = [
    "Alice", "Bob", "Cass", "Dev", "Eve", "Finn", "Gwen", "Hugo", "Iris", "Jack", "Kira", "Leo",
    "Mona", "Nia", "Otto", "Pip",
];

fn name_of(id: PlayerId) -> String {
    NAMES
        .get(id.index())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("P{}", id.index()))
}

fn role_tag(role: Role) -> &'static str {
    match role {
        Role::Villager => "Villager",
        Role::Werewolf => "Werewolf",
    }
}

// ----- parsed arguments ----------------------------------------------------

#[derive(Default)]
struct Args {
    players: Option<usize>,
    seat: Option<usize>,
    seed: Option<u64>,
    reveal: bool,
}

fn print_help() {
    println!(
        "wolf — play a game of werewolf against bots\n\
         \n\
         USAGE:\n\
         \x20   wolf [OPTIONS]\n\
         \n\
         OPTIONS:\n\
         \x20   -p, --players N   number of players (>= {min}); default: random 6-10\n\
         \x20       --seat N      seat you take, 0-based; default: random\n\
         \x20       --seed S      seed the deal and every bot choice for a reproducible game\n\
         \x20       --reveal      print every player's role each phase (debug)\n\
         \x20   -h, --help        show this help",
        min = Engine::MIN_PLAYERS,
    );
}

/// Pull a flag's value from `--flag=value` or the following argument.
fn take_value(
    inline: &Option<String>,
    it: &mut impl Iterator<Item = String>,
    key: &str,
) -> Result<String, String> {
    match inline {
        Some(v) => Ok(v.clone()),
        None => it.next().ok_or_else(|| format!("{key} needs a value")),
    }
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        match key.as_str() {
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            "--reveal" => args.reveal = true,
            "-p" | "--players" => {
                let v = take_value(&inline, &mut it, &key)?;
                args.players = Some(
                    v.parse()
                        .map_err(|_| format!("invalid player count: {v}"))?,
                );
            }
            "--seat" => {
                let v = take_value(&inline, &mut it, &key)?;
                args.seat = Some(v.parse().map_err(|_| format!("invalid seat: {v}"))?);
            }
            "--seed" => {
                let v = take_value(&inline, &mut it, &key)?;
                args.seed = Some(v.parse().map_err(|_| format!("invalid seed: {v}"))?);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if let Some(p) = args.players
        && p < Engine::MIN_PLAYERS
    {
        return Err(format!(
            "need at least {} players, got {p}",
            Engine::MIN_PLAYERS
        ));
    }
    Ok(args)
}

// ----- engine views the bots need ---------------------------------------------

fn living_ids(e: &Engine) -> Vec<PlayerId> {
    e.alive().map(|p| p.id()).collect()
}

fn living_wolves(e: &Engine) -> Vec<PlayerId> {
    e.alive()
        .filter(|p| p.role() == Role::Werewolf)
        .map(|p| p.id())
        .collect()
}

fn living_villagers(e: &Engine) -> Vec<PlayerId> {
    e.alive()
        .filter(|p| p.role() == Role::Villager)
        .map(|p| p.id())
        .collect()
}

fn is_wolf(e: &Engine, id: PlayerId) -> bool {
    e.role_of(id).map(|r| r == Role::Werewolf).unwrap_or(false)
}

/// The pack's fallback pick: a random living villager (the game guarantees one exists mid-phase).
fn random_living_villager(e: &Engine, rng: &mut SplitMix64) -> PlayerId {
    let mut pool = living_villagers(e);
    if pool.is_empty() {
        pool = living_ids(e);
    }
    *rng.choose(&pool).expect("a living player exists")
}

/// A random living player other than `exclude`.
fn random_living_other(e: &Engine, rng: &mut SplitMix64, exclude: PlayerId) -> PlayerId {
    let pool: Vec<PlayerId> = living_ids(e)
        .into_iter()
        .filter(|id| *id != exclude)
        .collect();
    rng.choose(&pool).copied().unwrap_or(exclude)
}

/// A villager bot's day vote: follow the human's lead 66% of the time, else vote at random.
fn villager_bot_vote(
    e: &Engine,
    rng: &mut SplitMix64,
    my_vote: Option<PlayerId>,
    bot: PlayerId,
) -> PlayerId {
    match my_vote {
        Some(v) if rng.chance(66) => v,
        _ => random_living_other(e, rng, bot),
    }
}

// ----- the run ------------------------------------------------------------

struct Table {
    engine: Engine,
    rng: SplitMix64,
    me: PlayerId,
    reveal: bool,
    night_victim: Option<PlayerId>,
    stdin: io::Stdin,
}

impl Table {
    fn i_am_wolf(&self) -> bool {
        is_wolf(&self.engine, self.me)
    }

    fn i_am_alive(&self) -> bool {
        self.engine.is_alive(self.me)
    }

    fn all_wolves(&self) -> Vec<PlayerId> {
        self.engine
            .players()
            .iter()
            .filter(|p| p.role() == Role::Werewolf)
            .map(|p| p.id())
            .collect()
    }

    /// Read a trimmed line, or `None` at end of input.
    fn read_line(&mut self) -> Option<String> {
        let mut buf = String::new();
        match self.stdin.read_line(&mut buf) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(buf.trim().to_string()),
        }
    }

    fn wait_for_enter(&mut self) {
        print!("[Enter] ");
        io::stdout().flush().ok();
        let _ = self.read_line();
    }

    /// Ask the human to pick one of `choices`, accepting a seat number or a name prefix.
    fn prompt_player(&mut self, question: &str, choices: &[PlayerId]) -> Option<PlayerId> {
        println!("{question}");
        let mut menu = String::from("  ");
        for id in choices {
            menu.push_str(&format!("{} {}", id.index(), name_of(*id)));
            if *id == self.me {
                menu.push_str("(you)");
            } else if self.i_am_wolf() && is_wolf(&self.engine, *id) {
                menu.push_str("(pack)");
            }
            menu.push_str("   ");
        }
        println!("{}", menu.trim_end());

        loop {
            print!("> ");
            io::stdout().flush().ok();
            let input = self.read_line()?;
            if input.is_empty() {
                continue;
            }
            if let Ok(n) = input.parse::<usize>()
                && let Some(id) = choices.iter().find(|c| c.index() == n)
            {
                return Some(*id);
            }
            let needle = input.to_lowercase();
            let hits: Vec<PlayerId> = choices
                .iter()
                .copied()
                .filter(|c| name_of(*c).to_lowercase().starts_with(&needle))
                .collect();
            if hits.len() == 1 {
                return Some(hits[0]);
            }
            println!("  not a valid choice — pick a number or name from the list");
        }
    }

    fn banner(&self, title: &str) {
        println!("\n── {title} ──────────────────────────────");
        if self.reveal {
            self.print_roster();
        }
    }

    fn print_roster(&self) {
        for p in self.engine.players() {
            let status = if p.is_alive() { "" } else { "  (dead)" };
            println!(
                "  {} {:<6} {}{}",
                p.id().index(),
                name_of(p.id()),
                role_tag(p.role()),
                status
            );
        }
    }

    /// One night: the pack names a victim and it is resolved.
    fn run_night(&mut self) -> Option<()> {
        self.banner(&format!("Night {}", self.engine.round()));

        let target = if self.i_am_alive() && self.i_am_wolf() {
            let choices: Vec<PlayerId> = living_ids(&self.engine)
                .into_iter()
                .filter(|id| *id != self.me)
                .collect();
            self.prompt_player("Werewolves, pick your target.", &choices)?
        } else {
            if self.i_am_alive() {
                println!("You close your eyes and wait for morning.");
            } else {
                println!("Night falls on the village. Everyone close your eyes.");
            }
            random_living_villager(&self.engine, &mut self.rng)
        };

        let mut pick = target;
        loop {
            for wolf in living_wolves(&self.engine) {
                self.engine
                    .night_action(wolf, pick)
                    .expect("wolf night action");
            }
            match self.engine.resolve_night().expect("resolve night") {
                NightOutcome::Killed(id) => {
                    self.night_victim = Some(id);
                    break;
                }
                // The pack is always unanimous, so this is only a safety net.
                NightOutcome::NoConsensus { .. } => {
                    println!("The pack split and nobody died. They pick again.");
                    pick = random_living_villager(&self.engine, &mut self.rng);
                }
            }
        }

        if !self.i_am_alive() {
            self.wait_for_enter();
        }
        Some(())
    }

    /// One day: the morning report, then everyone votes and it is resolved.
    fn run_day(&mut self) -> Option<()> {
        self.banner(&format!("Day {}", self.engine.round()));

        println!("Sun rises, everyone wake up!");
        if let Some(v) = self.night_victim.take() {
            let role = self.engine.role_of(v).expect("victim role");
            println!(
                "Sadly, {} was eliminated by the Werewolves! ({})",
                name_of(v),
                role_tag(role)
            );
        } else {
            println!("Everyone is still here — no one was eliminated in the night.");
        }

        let alive: Vec<String> = living_ids(&self.engine)
            .iter()
            .map(|id| name_of(*id))
            .collect();
        println!("Alive: {}", alive.join(", "));

        let my_vote = if self.i_am_alive() {
            let choices: Vec<PlayerId> = living_ids(&self.engine)
                .into_iter()
                .filter(|id| *id != self.me)
                .collect();
            Some(self.prompt_player("Who do you vote for?", &choices)?)
        } else {
            None
        };

        // Wolves bloc-vote: with the human leading the pack, that vote; otherwise a random villager.
        let wolf_target = if self.i_am_alive() && self.i_am_wolf() {
            my_vote.expect("a living human has voted")
        } else {
            random_living_villager(&self.engine, &mut self.rng)
        };

        let mut votes: BTreeMap<PlayerId, PlayerId> = BTreeMap::new();
        for id in living_ids(&self.engine) {
            let target = if id == self.me {
                my_vote.expect("a living human has voted")
            } else if is_wolf(&self.engine, id) {
                wolf_target
            } else {
                villager_bot_vote(&self.engine, &mut self.rng, my_vote, id)
            };
            self.engine.vote(id, target).expect("day vote");
            votes.insert(id, target);
        }

        let rendered: Vec<String> = votes
            .iter()
            .map(|(v, t)| format!("{}→{}", name_of(*v), name_of(*t)))
            .collect();
        println!("Votes: {}", rendered.join("  "));

        match self.engine.resolve_day().expect("resolve day") {
            DayOutcome::Eliminated(id) => {
                let role = self.engine.role_of(id).expect("lynched role");
                println!("{} was eliminated. ({})", name_of(id), role_tag(role));
            }
            DayOutcome::NoElimination => {
                println!("The vote was tied for the lead. No one was eliminated.");
            }
        }

        if !self.i_am_alive() {
            self.wait_for_enter();
        }
        Some(())
    }

    fn run(&mut self, seed: u64, players: usize) {
        let my_role = self.engine.role_of(self.me).expect("own role");
        println!(
            "Seed {seed} · {players} players · you are {} ({})",
            name_of(self.me),
            role_tag(my_role)
        );
        if my_role == Role::Werewolf {
            let pack: Vec<String> = self.all_wolves().iter().map(|id| name_of(*id)).collect();
            println!("Pack: {}", pack.join(", "));
        }

        let mut alive_last = true;
        while !self.engine.is_over() {
            let step = match self.engine.phase() {
                Phase::Night => self.run_night(),
                Phase::Day => self.run_day(),
                Phase::Ended => break,
            };
            if step.is_none() {
                println!("\nYou leave the table.");
                return;
            }
            if alive_last && !self.i_am_alive() {
                println!("\nYou are out of the game — sit back and watch it play out.");
                alive_last = false;
            }
        }

        self.print_ending();
    }

    fn print_ending(&self) {
        let winner = match self.engine.winner() {
            Some(Winner::Villagers) => "The Villagers win!",
            Some(Winner::Werewolves) => "The Werewolves win!",
            None => "The game ended.",
        };
        println!("\n══ {winner} ══");
        self.print_roster();
    }
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };

    let seed = args.seed.unwrap_or_else(rng::time_seed);
    let mut rng = SplitMix64::new(seed);
    let players = args.players.unwrap_or_else(|| 6 + rng.below(5) as usize);

    let engine = match Engine::with_seed(players, seed) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("cannot start game: {e}");
            std::process::exit(2);
        }
    };

    let me = match args.seat {
        Some(s) if s < players => PlayerId(s),
        Some(s) => {
            eprintln!("seat {s} is out of range 0..{players}");
            std::process::exit(2);
        }
        None => PlayerId(rng.below(players as u64) as usize),
    };

    let mut table = Table {
        engine,
        rng,
        me,
        reveal: args.reveal,
        night_victim: None,
        stdin: io::stdin(),
    };
    table.run(seed, players);
}

#[cfg(test)]
mod tests {
    use super::*;
    use wolf::Role::{Villager as V, Werewolf as W};

    /// Wolves at seats 0 and 5, villagers elsewhere.
    fn eng() -> Engine {
        Engine::with_roles(&[W, V, V, V, V, W, V]).expect("valid roster")
    }

    #[test]
    fn pack_pick_is_never_a_wolf() {
        let e = eng();
        let mut rng = SplitMix64::new(1);
        for _ in 0..1000 {
            assert!(!is_wolf(&e, random_living_villager(&e, &mut rng)));
        }
    }

    #[test]
    fn random_living_other_excludes_self_and_stays_alive() {
        let e = eng();
        let mut rng = SplitMix64::new(2);
        for _ in 0..1000 {
            let t = random_living_other(&e, &mut rng, PlayerId(3));
            assert_ne!(t, PlayerId(3));
            assert!(e.is_alive(t));
        }
    }

    #[test]
    fn villager_bot_with_no_lead_votes_a_living_nonself() {
        let e = eng();
        let mut rng = SplitMix64::new(7);
        for _ in 0..1000 {
            let t = villager_bot_vote(&e, &mut rng, None, PlayerId(2));
            assert_ne!(t, PlayerId(2));
            assert!(e.is_alive(t));
        }
    }

    #[test]
    fn villager_bot_follows_the_human_lead_most_of_the_time() {
        let e = eng();
        let mut rng = SplitMix64::new(42);
        let n = 4000;
        let copied = (0..n)
            .filter(|_| {
                villager_bot_vote(&e, &mut rng, Some(PlayerId(1)), PlayerId(3)) == PlayerId(1)
            })
            .count();
        let pct = copied * 100 / n;
        assert!((60..=80).contains(&pct), "copy rate was {pct}%");
    }

    #[test]
    fn chance_is_roughly_calibrated() {
        let mut rng = SplitMix64::new(99);
        let n = 10_000;
        let hits = (0..n).filter(|_| rng.chance(66)).count();
        let pct = hits * 100 / n;
        assert!((60..=72).contains(&pct), "chance(66) fired {pct}%");
    }
}
