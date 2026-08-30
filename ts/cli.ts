// An interactive werewolf CLI: you take one seat at a table of bots and play the
// engine by hand. The engine and PRNG are the Rust addon; everything else is here.

import {
  livingIds,
  livingWolves,
  isWolf,
  randomLivingVillager,
  villagerBotVote,
} from "./bots.js";
import { Game, GameError, Rng, timeSeed, type GameState } from "./engine.js";
import { banner, nameOf, printRoster, roleTag } from "./render.js";

// Matches wolf::Engine::MIN_PLAYERS.
const MIN_PLAYERS = 5;

const HELP = `wolf — play a game of werewolf against bots

USAGE:
    wolf [OPTIONS]

OPTIONS:
    -p, --players N   number of players (>= ${MIN_PLAYERS}); default: random 6-10
        --seat N      seat you take, 0-based; default: random
        --seed S      seed the deal and every bot choice for a reproducible game
        --reveal      print every player's role each phase (debug)
    -h, --help        show this help`;

// ----- parsed arguments ----------------------------------------------------

interface Args {
  players?: number;
  seat?: number;
  seed?: bigint;
  reveal: boolean;
}

class CliError extends Error {}

const U64_MAX = (1n << 64n) - 1n;

function parseArgs(argv: string[]): Args {
  const args: Args = { reveal: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i++]!;
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : null;

    const takeValue = (): string => {
      if (inline !== null) return inline;
      if (i >= argv.length) throw new CliError(`${key} needs a value`);
      return argv[i++]!;
    };

    switch (key) {
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      case "--reveal":
        args.reveal = true;
        break;
      case "-p":
      case "--players": {
        const v = takeValue();
        if (!/^\d+$/.test(v)) throw new CliError(`invalid player count: ${v}`);
        args.players = Number(v);
        break;
      }
      case "--seat": {
        const v = takeValue();
        if (!/^\d+$/.test(v)) throw new CliError(`invalid seat: ${v}`);
        args.seat = Number(v);
        break;
      }
      case "--seed": {
        const v = takeValue();
        if (!/^\d+$/.test(v)) throw new CliError(`invalid seed: ${v}`);
        const s = BigInt(v);
        if (s > U64_MAX) throw new CliError(`invalid seed: ${v}`);
        args.seed = s;
        break;
      }
      default:
        throw new CliError(`unknown argument: ${key}`);
    }
  }

  if (args.players !== undefined && args.players < MIN_PLAYERS) {
    throw new CliError(`need at least ${MIN_PLAYERS} players, got ${args.players}`);
  }
  return args;
}

// ----- stdin, one trimmed line at a time --------------------------------------

class LineReader {
  private it = Bun.stdin.stream()[Symbol.asyncIterator]();
  private decoder = new TextDecoder();
  private buf = "";
  private queue: string[] = [];
  private closed = false;

  // The next line trimmed, or null at end of input.
  async next(): Promise<string | null> {
    for (;;) {
      const ready = this.queue.shift();
      if (ready !== undefined) return ready.trim();
      if (this.closed) {
        if (this.buf.length === 0) return null;
        const rest = this.buf;
        this.buf = "";
        return rest.trim();
      }
      const chunk = await this.it.next();
      if (chunk.done) {
        this.closed = true;
        continue;
      }
      this.buf += this.decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        this.queue.push(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
      }
    }
  }
}

// ----- the run ------------------------------------------------------------

class Table {
  private nightVictim: number | null = null;

  constructor(
    private game: Game,
    private rng: Rng,
    private me: number,
    private reveal: boolean,
    private reader: LineReader,
  ) {}

  private state(): GameState {
    return this.game.state();
  }

  private iAmWolf(): boolean {
    return this.game.roleOf(this.me) === "Werewolf";
  }

  private iAmAlive(): boolean {
    return this.game.isAlive(this.me);
  }

  // Ask the human to pick one of `choices`, accepting a seat number or a name prefix.
  private async promptPlayer(question: string, choices: number[]): Promise<number | null> {
    console.log(question);
    let menu = "  ";
    for (const id of choices) {
      menu += `${id} ${nameOf(id)}`;
      if (id === this.me) menu += "(you)";
      else if (this.iAmWolf() && isWolf(this.state(), id)) menu += "(pack)";
      menu += "   ";
    }
    console.log(menu.trimEnd());

    for (;;) {
      process.stdout.write("> ");
      const input = await this.reader.next();
      if (input === null) return null;
      if (input === "") continue;

      if (/^\d+$/.test(input)) {
        const n = Number(input);
        const hit = choices.find((c) => c === n);
        if (hit !== undefined) return hit;
      }
      const needle = input.toLowerCase();
      const hits = choices.filter((c) => nameOf(c).toLowerCase().startsWith(needle));
      if (hits.length === 1) return hits[0]!;
      console.log("  not a valid choice — pick a number or name from the list");
    }
  }

  private async waitForEnter(): Promise<void> {
    process.stdout.write("[Enter] ");
    await this.reader.next();
  }

  private drawBanner(title: string): void {
    banner(title, this.state(), this.reveal);
  }

  // One night: the pack names a victim and it is resolved.
  private async runNight(): Promise<boolean> {
    this.drawBanner(`Night ${this.state().round}`);

    let target: number;
    if (this.iAmAlive() && this.iAmWolf()) {
      const choices = livingIds(this.state()).filter((id) => id !== this.me);
      const picked = await this.promptPlayer("Werewolves, pick your target.", choices);
      if (picked === null) return false;
      target = picked;
    } else {
      console.log(
        this.iAmAlive()
          ? "You close your eyes and wait for morning."
          : "Night falls on the village. Everyone close your eyes.",
      );
      target = randomLivingVillager(this.state(), this.rng);
    }

    let pick = target;
    for (;;) {
      for (const wolf of livingWolves(this.state())) {
        this.game.nightAction(wolf, pick);
      }
      const outcome = this.game.resolveNight();
      if (outcome.kind === "Killed") {
        this.nightVictim = outcome.killed ?? null;
        break;
      }
      // The pack is always unanimous, so this is only a safety net.
      console.log("The pack split and nobody died. They pick again.");
      pick = randomLivingVillager(this.state(), this.rng);
    }

    if (!this.iAmAlive()) await this.waitForEnter();
    return true;
  }

  // One day: the morning report, then everyone votes and it is resolved.
  private async runDay(): Promise<boolean> {
    this.drawBanner(`Day ${this.state().round}`);

    console.log("Sun rises, everyone wake up!");
    if (this.nightVictim !== null) {
      const victim = this.nightVictim;
      this.nightVictim = null;
      console.log(
        `Sadly, ${nameOf(victim)} was eliminated by the Werewolves! (${roleTag(this.game.roleOf(victim))})`,
      );
    } else {
      console.log("Everyone is still here — no one was eliminated in the night.");
    }

    const alive = livingIds(this.state()).map(nameOf);
    console.log(`Alive: ${alive.join(", ")}`);

    let myVote: number | null = null;
    if (this.iAmAlive()) {
      const choices = livingIds(this.state()).filter((id) => id !== this.me);
      const picked = await this.promptPlayer("Who do you vote for?", choices);
      if (picked === null) return false;
      myVote = picked;
    }

    // Wolves bloc-vote: with the human leading the pack, that vote; otherwise a random villager.
    const wolfTarget =
      this.iAmAlive() && this.iAmWolf()
        ? myVote!
        : randomLivingVillager(this.state(), this.rng);

    const votes: Array<[number, number]> = [];
    for (const id of livingIds(this.state())) {
      let target: number;
      if (id === this.me) target = myVote!;
      else if (isWolf(this.state(), id)) target = wolfTarget;
      else target = villagerBotVote(this.state(), this.rng, myVote, id);
      this.game.vote(id, target);
      votes.push([id, target]);
    }

    const rendered = votes.map(([v, t]) => `${nameOf(v)}→${nameOf(t)}`);
    console.log(`Votes: ${rendered.join("  ")}`);

    const outcome = this.game.resolveDay();
    if (outcome.kind === "Eliminated") {
      const id = outcome.eliminated ?? 0;
      console.log(`${nameOf(id)} was eliminated. (${roleTag(this.game.roleOf(id))})`);
    } else {
      console.log("The vote was tied for the lead. No one was eliminated.");
    }

    if (!this.iAmAlive()) await this.waitForEnter();
    return true;
  }

  async run(seed: bigint, players: number): Promise<void> {
    const myRole = this.game.roleOf(this.me);
    console.log(
      `Seed ${seed} · ${players} players · you are ${nameOf(this.me)} (${roleTag(myRole)})`,
    );
    if (myRole === "Werewolf") {
      const pack = this.state()
        .players.filter((p) => p.role === "Werewolf")
        .map((p) => nameOf(p.id));
      console.log(`Pack: ${pack.join(", ")}`);
    }

    let aliveLast = true;
    while (!this.state().isOver) {
      const phase = this.state().phase;
      let step: boolean;
      if (phase === "Night") step = await this.runNight();
      else if (phase === "Day") step = await this.runDay();
      else break;

      if (!step) {
        console.log("\nYou leave the table.");
        return;
      }
      if (aliveLast && !this.iAmAlive()) {
        console.log("\nYou are out of the game — sit back and watch it play out.");
        aliveLast = false;
      }
    }

    this.printEnding();
  }

  private printEnding(): void {
    const winner = this.state().winner;
    const line =
      winner === "Villagers"
        ? "The Villagers win!"
        : winner === "Werewolves"
          ? "The Werewolves win!"
          : "The game ended.";
    console.log(`\n══ ${line} ══`);
    printRoster(this.state());
  }
}

// ----- entry point ---------------------------------------------------------

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    process.exit(2);
  }

  const seed = args.seed ?? timeSeed();
  const rng = new Rng(seed);
  const players = args.players ?? 6 + rng.below(5);

  let game: Game;
  try {
    game = Game.withSeed(players, seed);
  } catch (thrown) {
    console.error(`cannot start game: ${GameError.fromThrown(thrown).message}`);
    process.exit(2);
  }

  let me: number;
  if (args.seat !== undefined) {
    if (args.seat >= players) {
      console.error(`seat ${args.seat} is out of range 0..${players}`);
      process.exit(2);
    }
    me = args.seat;
  } else {
    me = rng.below(players);
  }

  const table = new Table(game, rng, me, args.reveal, new LineReader());
  await table.run(seed, players);
}

await main();
