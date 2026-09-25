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

function opening(roles: Role[]) {
  const source = input();
  const game = Game.withRoles(roles);
  const log = spyOn(console, "log").mockImplementation(() => {});
  spies.push(
    log,
    spyOn(process.stdout, "write").mockImplementation(() => true),
  );
  const table = new Table(game, new Rng(42n), 0, false, source.reader, () => 40);
  // biome-ignore lint/complexity/useLiteralKeys: Exercise this phase without running the entire interactive game.
  return { ...source, game, log, run: () => table["runOpening"]() };
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

describe("CLI opening", () => {
  test.each([
    ["Villager", "Werewolf", "Villager", "Villager", "Villager"],
    ["Villager", "Werewolf", "Seer", "Villager", "Villager"],
    ["Seer", "Werewolf", "Villager", "Villager", "Villager"],
  ] as Role[][])("waits the full deadline for roster %j", async (...roles) => {
    const session = opening(roles);
    const action = spyOn(session.game, "seerAction");
    if (roles[0] === "Seer") session.send("1\n");
    const start = performance.now();
    const running = session.run();
    await Bun.sleep(5);
    expect(session.game.state().phase).toBe("Opening");
    expect(action).toHaveBeenCalledTimes(roles.includes("Seer") ? 1 : 0);
    expect(await running).toBe(true);
    expect(performance.now() - start).toBeGreaterThanOrEqual(40);
    expect(session.game.state().phase).toBe("Day");
    expect(session.game.state().round).toBe(1);
    if (roles[0] !== "Seer") {
      const output = session.log.mock.calls.flat().join("\n");
      expect(output).not.toMatch(/inspection|Seer/);
    }
    session.close();
  });

  test("a human Seer can time out after invalid input and use late input on Day 1", async () => {
    const session = opening(["Seer", "Werewolf", "Villager", "Villager", "Villager"]);
    const action = spyOn(session.game, "seerAction");
    session.send("invalid\n\n99\n");
    expect(await session.run()).toBe(true);
    expect(action).not.toHaveBeenCalled();
    expect(session.game.state().phase).toBe("Day");
    session.send("2\n");
    expect(await session.reader.next()).toBe("2");
    session.close();
  });

  test.each(["Seer", "Villager"] as Role[])("EOF exits the opening for %s", async (role) => {
    const session = opening([role, "Werewolf", "Villager", "Villager", "Villager"]);
    session.close();
    expect(await session.run()).toBe(false);
    expect(session.game.state().phase).toBe("Opening");
  });
});
