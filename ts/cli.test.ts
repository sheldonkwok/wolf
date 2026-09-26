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
