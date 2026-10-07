import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LineReader, Table } from "./cli.js";
import { Game, Rng, type Role } from "./engine.js";

function input() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const iterator = stream[Symbol.asyncIterator]();
  const reads = spyOn(iterator, "next");
  return {
    reader: new LineReader(iterator),
    reads,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
  };
}

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function inspection(roles: Role[]) {
  const source = input();
  const game = Game.withRoles(roles);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spies.push(
    log,
    spyOn(process.stdout, "write").mockImplementation(() => true),
  );
  const table = new Table(game, new Rng(42n), 0, false, source.reader);
  // biome-ignore lint/complexity/useLiteralKeys: Exercise this step without running the entire interactive game.
  return { ...source, game, log, run: () => table["runDayInspection"]() };
}

describe("deadline-aware CLI input", () => {
  test("retains the pending chunk across timeout without another iterator read", async () => {
    const source = input();
    expect(await source.reader.next(performance.now() + 5)).toBeUndefined();
    expect(source.reads).toHaveBeenCalledTimes(1);
    const nextDay = source.reader.next();
    expect(source.reads).toHaveBeenCalledTimes(1);
    source.send("  Bob\nCass\n");
    expect(await nextDay).toBe("Bob");
    expect(await source.reader.next()).toBe("Cass");
    source.close();
    expect(await source.reader.next()).toBeNull();
  });

  test("expired deadlines do not consume queued input", async () => {
    const source = input();
    source.send("Alice\nBob\n");
    expect(await source.reader.next()).toBe("Alice");
    expect(await source.reader.next(performance.now())).toBeUndefined();
    expect(await source.reader.next()).toBe("Bob");
    source.close();
  });

  test("partial lines survive a deadline and EOF", async () => {
    const source = input();
    source.send("Al");
    expect(await source.reader.next(performance.now() + 5)).toBeUndefined();
    source.send("ice");
    source.close();
    expect(await source.reader.next()).toBe("Alice");
    expect(await source.reader.next()).toBeNull();
  });
});

function day(draws: number[], followHuman = false) {
  const source = input();
  const game = Game.withRoles(["Villager", "Werewolf", "Villager", "Villager", "Villager"]);
  const rng = new Rng(42n);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const vote = spyOn(game, "vote");
  spies.push(
    log,
    vote,
    spyOn(process.stdout, "write").mockImplementation(() => true),
    spyOn(rng, "chance").mockReturnValue(followHuman),
    spyOn(rng, "below").mockImplementation((limit) => {
      const draw = draws.shift();
      if (draw === undefined || draw >= limit) throw new Error("Unexpected bot RNG draw");
      return draw;
    }),
  );
  const table = new Table(game, rng, 0, false, source.reader);
  source.send("2\n");
  source.close();
  // biome-ignore lint/complexity/useLiteralKeys: Exercise this phase without running the entire interactive game.
  return { game, log, vote, run: () => table["runDay"]() };
}

describe("CLI day resolution", () => {
  test("a complete tied ballot starts night without a death or another prompt", async () => {
    const session = day([2, 2, 2, 0]);
    expect(await session.run()).toBe(true);
    expect(session.vote.mock.calls).toEqual([
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 2],
      [4, 0],
    ]);
    expect(session.game.state().phase).toBe("Night");
    expect(session.game.state().round).toBe(1);
    expect(session.game.state().players.every((player) => player.alive)).toBe(true);
    const output = session.log.mock.calls.flat().join("\n");
    expect(output).toContain("The vote is tied. No one was eliminated; night falls.");
    expect(output).not.toMatch(/was eliminated\. \(|No majority|Discuss and vote again/);
    expect(output.match(/Who do you vote for/g)).toHaveLength(1);
  });

  test("a complete unique plurality eliminates its leader without a majority", async () => {
    const session = day([2, 3, 2, 0]);
    expect(await session.run()).toBe(true);
    expect(session.vote.mock.calls).toEqual([
      [0, 2],
      [1, 3],
      [2, 4],
      [3, 2],
      [4, 0],
    ]);
    expect(session.game.isAlive(2)).toBe(false);
    expect(session.game.state().players.filter((player) => player.alive)).toHaveLength(4);
    expect(session.game.state().phase).toBe("Night");
    expect(session.game.state().round).toBe(1);
    const output = session.log.mock.calls.flat().join("\n");
    expect(output).toContain("was eliminated.");
    expect(output).not.toContain("No majority");
    expect(output.match(/Who do you vote for/g)).toHaveLength(1);
  });

  test("the bot loop stops once the remaining voter completes a tied ballot", async () => {
    const session = day([2]);
    session.game.vote(2, 3);
    session.game.vote(3, 2);
    session.game.vote(4, 0);
    session.vote.mockClear();
    expect(await session.run()).toBe(true);
    expect(session.vote.mock.calls).toEqual([
      [0, 2],
      [1, 3],
    ]);
    expect(session.game.state().phase).toBe("Night");
    expect(session.game.state().players.every((player) => player.alive)).toBe(true);
  });

  test("an early strict majority stops bots before the last vote", async () => {
    const session = day([2], true);
    expect(await session.run()).toBe(true);
    expect(session.vote.mock.calls).toEqual([
      [0, 2],
      [1, 3],
      [2, 2],
      [3, 2],
    ]);
    expect(session.game.isAlive(2)).toBe(false);
    expect(session.game.state().phase).toBe("Night");
  });
});

describe("CLI Day 1 inspection", () => {
  test.each([
    ["Villager", "Werewolf", "Villager", "Villager", "Villager"],
    ["Villager", "Werewolf", "Seer", "Villager", "Villager"],
  ] as Role[][])("only a living Seer inspects, silently for bots, in roster %j", async (...roles) => {
    const session = inspection(roles);
    expect(await session.run()).toBe(true);
    expect(session.game.state().inspections).toHaveLength(roles.includes("Seer") ? 1 : 0);
    expect(session.game.state().inspections.every((result) => result.phase === "Day")).toBe(true);
    expect(session.log.mock.calls.flat().join("\n")).not.toMatch(/inspect|Seer|innocent|Werewolf/);
    expect(await session.run()).toBe(true);
    expect(session.game.state().inspections).toHaveLength(roles.includes("Seer") ? 1 : 0);
    session.close();
  });

  test("a human Seer retries invalid input and privately learns the result", async () => {
    const session = inspection(["Seer", "Werewolf", "Villager", "Villager", "Villager"]);
    session.send("invalid\n\n99\n1\n");
    expect(await session.run()).toBe(true);
    expect(session.game.state().inspections).toEqual([
      { seer: 0, target: 1, round: 1, phase: "Day", isWerewolf: true },
    ]);
    expect(session.game.state().phase).toBe("Day");
    expect(session.log.mock.calls.flat()).toContain("Bob is a Werewolf.");
    session.close();
  });

  test("EOF exits at the Day 1 inspection", async () => {
    const session = inspection(["Seer", "Werewolf", "Villager", "Villager", "Villager"]);
    session.close();
    expect(await session.run()).toBe(false);
    expect(session.game.state().inspections).toEqual([]);
  });
});

// A table at Night 1 with everyone alive; `draws` and `chances` script the bots.
function night(roles: Role[], draws: number[], chances: boolean[] = []) {
  const source = input();
  const game = Game.withRoles(roles);
  const tieDay = () => {
    const living = game
      .state()
      .players.filter((p) => p.alive)
      .map((p) => p.id);
    for (const [index, voter] of living.entries()) game.vote(voter, living[(index + 1) % living.length]!);
    game.resolveDay();
  };
  tieDay();
  const rng = new Rng(42n);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spies.push(
    log,
    spyOn(process.stdout, "write").mockImplementation(() => true),
    spyOn(rng, "chance").mockImplementation(() => {
      const chance = chances.shift();
      if (chance === undefined) throw new Error("Unexpected bot RNG chance");
      return chance;
    }),
    spyOn(rng, "below").mockImplementation((limit) => {
      const draw = draws.shift();
      if (draw === undefined || draw >= limit) throw new Error("Unexpected bot RNG draw");
      return draw;
    }),
  );
  const table = new Table(game, rng, 0, false, source.reader);
  return {
    ...source,
    game,
    draws,
    tieDay,
    output: () => log.mock.calls.flat().join("\n"),
    // biome-ignore lint/complexity/useLiteralKeys: Exercise this phase without running the entire interactive game.
    runNight: () => table["runNight"](),
    // biome-ignore lint/complexity/useLiteralKeys: Exercise this phase without running the entire interactive game.
    runDay: () => table["runDay"](),
  };
}

describe("CLI Witch", () => {
  const HUMAN: Role[] = ["Witch", "Werewolf", "Villager", "Villager", "Villager", "Villager", "Villager"];
  const BOT: Role[] = ["Villager", "Werewolf", "Witch", "Villager", "Villager", "Villager", "Villager"];

  test("a human Witch sees the victim, heals, and is blind on later nights", async () => {
    const session = night(HUMAN, [1]);
    session.send("heal\n");
    expect(await session.runNight()).toBe(true);
    expect(session.game.state()).toMatchObject({ phase: "Day", round: 2, healAvailable: false });
    expect(session.game.state().players.every((p) => p.alive)).toBe(true);
    expect(session.output()).toContain("Witch, the Werewolves attacked Cass.");
    expect(session.output()).toContain("  heal   poison   nothing");

    session.tieDay();
    session.draws.push(1);
    session.send("h\nn\n");
    expect(await session.runNight()).toBe(true);
    expect(session.output()).toContain(
      "Witch, your healing potion is spent, so you are not told who was attacked.",
    );
    expect(session.output()).toContain("  poison   nothing");
    expect(session.output()).toContain("not a valid choice — type one of the words from the list");
    expect(session.game.isAlive(2)).toBe(false);
    expect(session.game.state()).toMatchObject({ phase: "Day", round: 3, poisonAvailable: true });
    session.close();
  });

  test("the morning after a heal reports a save without naming the saver", async () => {
    const session = night(HUMAN, [1]);
    session.send("heal\n");
    session.close();
    expect(await session.runNight()).toBe(true);
    expect(await session.runDay()).toBe(false);
    expect(session.output()).toContain("The Werewolves attacked Cass, but they were saved!");
    expect(session.output()).not.toMatch(/Sadly|Doctor|Witch saved/);
  });

  test("a human Witch retries bad input, poisons, and the morning reports both deaths", async () => {
    const session = night(HUMAN, [1]);
    session.send("x\n\np\nzz\n0\n3\n");
    session.close();
    expect(await session.runNight()).toBe(true);
    expect(session.game.state()).toMatchObject({ phase: "Day", round: 2, healAvailable: true });
    expect(session.game.state().poisonAvailable).toBe(false);
    expect(
      session.game
        .state()
        .players.filter((p) => !p.alive)
        .map((p) => p.id),
    ).toEqual([2, 3]);
    expect(session.output()).toContain("Who do you poison?");
    expect(session.output().match(/not a valid choice/g)).toHaveLength(3);
    expect(await session.runDay()).toBe(false);
    expect(session.output()).toContain("Sadly, Cass was eliminated during the night! (Villager)");
    expect(session.output()).toContain("Sadly, Dev was eliminated during the night! (Villager)");
    expect(session.output()).not.toContain("saved");
  });

  test("an attacked human Witch is told so and may let the attack land", async () => {
    const session = night(HUMAN, [0]);
    session.send("nothing\n");
    session.close();
    expect(await session.runNight()).toBe(true);
    expect(session.output()).toContain("Witch, the Werewolves attacked you.");
    expect(session.game.isAlive(0)).toBe(false);
    expect(session.game.state()).toMatchObject({ healAvailable: true, poisonAvailable: true });
  });

  test.each([
    ["", "the potion prompt"],
    ["poison\n", "the poison target"],
  ])("EOF after %j leaves the night waiting at %s", async (typed) => {
    const session = night(HUMAN, [1]);
    session.send(typed);
    session.close();
    expect(await session.runNight()).toBe(false);
    expect(session.game.state()).toMatchObject({
      phase: "Night",
      round: 1,
      pendingActors: [0],
      witchVictim: 2,
      healAvailable: true,
      poisonAvailable: true,
    });
    expect(session.game.state().players.every((p) => p.alive)).toBe(true);
  });

  const botTurns: {
    name: string;
    draws: number[];
    chances: boolean[];
    dead: number[];
    heal: boolean;
    poison: boolean;
  }[] = [
    { name: "heals", draws: [3], chances: [true], dead: [], heal: false, poison: true },
    { name: "passes", draws: [3], chances: [false, false], dead: [4], heal: true, poison: true },
    { name: "poisons", draws: [3, 4], chances: [false, true], dead: [4, 5], heal: true, poison: false },
  ];
  test.each(botTurns)(
    "a bot Witch $name without prompting the human",
    async ({ draws, chances, dead, heal, poison }) => {
      const session = night(BOT, draws, chances);
      session.close();
      expect(await session.runNight()).toBe(true);
      expect(session.reads).not.toHaveBeenCalled();
      expect(session.output()).not.toMatch(/Witch|potion|attacked/);
      expect(session.game.state()).toMatchObject({
        phase: "Day",
        round: 2,
        healAvailable: heal,
        poisonAvailable: poison,
      });
      expect(
        session.game
          .state()
          .players.filter((p) => !p.alive)
          .map((p) => p.id),
      ).toEqual(dead);
      expect(draws).toEqual([]);
      expect(chances).toEqual([]);
    },
  );
});
