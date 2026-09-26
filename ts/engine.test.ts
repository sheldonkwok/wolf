// Exercise the public wrapper against the native engine and malformed boundary results.

import { expect, spyOn, test } from "bun:test";
import { Game, GameError, Rng, timeSeed } from "./engine.js";
import { Game as NativeGame } from "./native/index.js";

function reachNight(game: Game): void {
  const seer = game.state().pendingInspectors[0];
  if (seer !== undefined) game.seerAction(seer, 0);
  const players = game.state().players.filter((p) => p.alive);
  const target = players.findLast((p) => p.role === "Villager")!.id;
  for (const player of players) game.vote(player.id, target);
  expect(game.resolveDay()).toEqual({ kind: "Eliminated", eliminated: target });
  expect(game.state().phase).toBe("Night");
  expect(game.state().round).toBe(1);
}

test("withSeed is reproducible and matches the Rust deal", () => {
  // Seed 100 / 7 players deals the wolves to seats 0 and 6.
  const a = Game.withSeed(7, 100n).state();
  const b = Game.withSeed(7, 100n).state();
  expect(a).toEqual(b);
  expect(a.phase).toBe("Day");
  expect(a.round).toBe(1);
  expect(a.players.every((p) => p.alive)).toBe(true);
  expect(a.majorityRequired).toBe(4);
  expect(a.majorityTarget).toBeUndefined();
  expect(a.pendingActors).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(a.pendingInspectors).toEqual([2]);
  expect(a.players.filter((p) => p.role === "Werewolf").map((p) => p.id)).toEqual([0, 6]);
});

test("Rng stream matches SplitMix64(100)", () => {
  const rng = new Rng(100n);
  expect(rng.below(7)).toBe(3); // the CLI's seat draw for seed 100 / 7 players
});

test("timeSeed returns a u64-range bigint", () => {
  const s = timeSeed();
  expect(typeof s).toBe("bigint");
  expect(s).toBeGreaterThanOrEqual(0n);
});

test("Day 1 accepts votes and can end in a villager win before night", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  expect(game.state().phase).toBe("Day");
  const before = game.state();
  expect(grab(() => game.nightAction(0, 1)).code).toBe("WrongPhase");
  expect(grab(() => game.resolveNight()).code).toBe("WrongPhase");
  expect(grab(() => game.resolveDay()).code).toBe("NoMajority");
  expect(game.state()).toEqual(before);

  for (const voter of [0, 1, 2, 3, 4]) game.vote(voter, voter === 0 ? 2 : 0);
  const day = game.resolveDay();
  expect(day).toEqual({ kind: "Eliminated", eliminated: 0 });

  const end = game.state();
  expect(end.isOver).toBe(true);
  expect(end.winner).toBe("Villagers");
  expect(end.round).toBe(1);
  expect(end.players.filter((p) => p.alive).length).toBe(4);
});

test("a split pack resolves to NoConsensus and stays in Night", () => {
  const game = Game.withRoles(["Werewolf", "Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  game.nightAction(0, 2);
  game.nightAction(1, 3);
  const night = game.resolveNight();
  expect(night.kind).toBe("NoConsensus");
  if (night.kind === "NoConsensus") expect(night.targets.sort()).toEqual([2, 3]);
  expect(game.state().phase).toBe("Night");
});

test("a lone wolf cannot target itself and a rejected pick leaves state unchanged", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  const before = game.state();
  expect(grab(() => game.nightAction(0, 0)).code).toBe("LastWolfCannotTargetSelf");
  expect(game.state()).toEqual(before);
  game.nightAction(0, 1);
  expect(game.resolveNight()).toEqual({ kind: "Killed", killed: 1 });
});

test("majority crosses the binding and votes clear after resolution", () => {
  const game = Game.withRoles([
    "Werewolf",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
  ]);
  expect(game.state().majorityRequired).toBe(4);
  for (const voter of [0, 1, 2]) game.vote(voter, 6);
  const before = game.state();
  expect(grab(() => game.resolveDay()).code).toBe("NoMajority");
  expect(game.state()).toEqual(before);
  game.vote(3, 6);
  expect(game.state().majorityTarget).toBe(6);
  expect(game.state().pendingActors).toEqual([4, 5, 6]);
  expect(game.resolveDay()).toEqual({ kind: "Eliminated", eliminated: 6 });
  expect(game.state().votes).toEqual([]);
  expect(game.state().majorityTarget).toBeUndefined();
  expect(grab(() => game.vote(0, 1)).code).toBe("WrongPhase");
  game.nightAction(0, 1);
  game.resolveNight();
  expect(game.state().majorityRequired).toBe(3);
  expect(grab(() => game.vote(1, 0)).code).toBe("PlayerNotAlive");
  expect(grab(() => game.vote(0, 6)).code).toBe("PlayerNotAlive");
  expect(grab(() => game.vote(99, 0)).code).toBe("UnknownPlayer");
});

test.each([
  { targets: [0, 0, 0, 1, 1, 2, 2, 3], result: { kind: "Eliminated", eliminated: 0 } },
  { targets: [0, 0, 0, 0, 1, 1, 1, 1], result: { kind: "Tied" } },
])("complete ballots resolve through the binding: %j", ({ targets, result }) => {
  const game = Game.withRoles([
    "Villager",
    "Werewolf",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
  ]);
  for (let voter = 0; voter < targets.length - 1; voter++) game.vote(voter, targets[voter]!);
  const before = game.state();
  expect(grab(() => game.resolveDay()).code).toBe("NoMajority");
  expect(game.state()).toEqual(before);
  game.vote(7, targets[7]!);
  expect(game.state().majorityTarget).toBeUndefined();
  expect(game.state().pendingActors).toEqual([]);
  expect(game.resolveDay()).toEqual(result);
  expect(game.state()).toMatchObject({ phase: "Night", round: 1, votes: [] });
  expect(game.state().players.filter((p) => p.alive)).toHaveLength(result.kind === "Tied" ? 8 : 7);
  expect(grab(() => game.vote(7, 0)).code).toBe("WrongPhase");
});

test("unknown player throws UnknownPlayer", () => {
  const game = Game.withSeed(5, 1n);
  const error = grab(() => game.roleOf(99));
  expect(error.code).toBe("UnknownPlayer");
  expect(error.message).toBe("no such player: P99");
});

test("votes can be changed and repeated without counting twice", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  game.vote(2, 0);
  game.vote(2, 0);
  game.vote(2, 3);
  expect(game.state().votes).toEqual([{ voter: 2, target: 3 }]);
  expect(grab(() => game.resolveDay()).code).toBe("NoMajority");
});

test("too few players throws TooFewPlayers", () => {
  expect(grab(() => new Game(3)).code).toBe("TooFewPlayers");
  expect(grab(() => Game.withSeed(3, 1n)).code).toBe("TooFewPlayers");
  expect(grab(() => Game.withRoles(["Villager"])).code).toBe("TooFewPlayers");
});

test("all constructors produce usable wrapper instances", () => {
  for (const game of [
    new Game(5),
    Game.withSeed(5, 1n),
    Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]),
  ]) {
    expect(game).toBeInstanceOf(Game);
    expect(game.state().players).toHaveLength(5);
    expect(game.isAlive(0)).toBe(true);
    expect(game.isAlive(99)).toBe(false);
    expect(game.roleOf(0)).toBe(game.state().players[0]!.role);
  }
});

test("invalid rosters, non-wolf actions, and commands after game over throw typed errors", () => {
  expect(grab(() => Game.withRoles(Array(5).fill("Villager"))).code).toBe("InvalidRoster");
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  expect(grab(() => game.nightAction(1, 2)).code).toBe("NotAWerewolf");
  game.nightAction(0, 1);
  game.resolveNight();
  for (const id of [0, 2, 3]) game.vote(id, 0);
  expect(game.resolveDay()).toEqual({ kind: "Eliminated", eliminated: 0 });
  expect(grab(() => game.vote(2, 0)).code).toBe("GameOver");
});

test("night resolution preserves seat zero", () => {
  const game = Game.withRoles(["Villager", "Werewolf", "Villager", "Villager", "Villager"]);
  reachNight(game);
  game.nightAction(1, 0);
  expect(game.resolveNight()).toEqual({ kind: "Killed", killed: 0 });
});

test("error conversion validates tags and preserves typed errors", () => {
  const error = new GameError("UnknownPlayer", "no such player: P99");
  expect(GameError.fromThrown(error)).toBe(error);
  expect(GameError.fromThrown(new Error("UnknownPlayer: no such player: P99"))).toMatchObject({
    code: "UnknownPlayer",
    message: "no such player: P99",
  });
  for (const thrown of [new Error("Unexpected: detail"), "plain failure", null]) {
    expect(GameError.fromThrown(thrown)).toMatchObject({
      code: "Unknown",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
});

const malformedResults: Array<["resolveDay" | "resolveNight", unknown]> = [
  ["resolveDay", { kind: "Eliminated" }],
  ["resolveDay", { kind: "Eliminated", eliminated: null }],
  ["resolveDay", { kind: "Eliminated", eliminated: -1 }],
  ["resolveDay", { kind: "Eliminated", eliminated: 1.5 }],
  ["resolveDay", { kind: "Unexpected" }],
  ["resolveDay", { kind: "Tied", eliminated: 0 }],
  ["resolveDay", { kind: "Tied", eliminated: "0" }],
  ["resolveDay", null],
  ["resolveNight", { kind: "Killed", targets: [] }],
  ["resolveNight", { kind: "Killed", killed: "0", targets: [] }],
  ["resolveNight", { kind: "Killed", killed: NaN, targets: [] }],
  ["resolveNight", { kind: "Killed", killed: Number.MAX_SAFE_INTEGER + 1, targets: [] }],
  ["resolveNight", { kind: "Saved" }],
  ["resolveNight", { kind: "Saved", saved: -1 }],
  ["resolveNight", { kind: "NoConsensus" }],
  ["resolveNight", { kind: "NoConsensus", targets: [1, "2"] }],
  ["resolveNight", { kind: "Unexpected", targets: [] }],
  ["resolveNight", undefined],
];

test.each(malformedResults)("%s rejects malformed native result %j", (method, result) => {
  const game = Game.withSeed(5, 1n);
  const mock = spyOn(NativeGame.prototype, method).mockReturnValue(result as never);
  try {
    const error = grab(() => game[method]());
    expect(error.code).toBe("Unknown");
    expect(error.message).toContain("resolution from native addon");
  } finally {
    mock.mockRestore();
  }
});

// Run a call that must throw and return it as a typed GameError.
function grab(call: () => unknown): GameError {
  try {
    call();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(GameError);
    if (thrown instanceof GameError) return thrown;
    throw thrown;
  }
  throw new Error("expected the call to throw");
}

test("Hunter actions and validation cross the binding, including seat zero", () => {
  const game = Game.withRoles(["Hunter", "Werewolf", "Villager", "Villager", "Villager"]);
  reachNight(game);
  game.nightAction(1, 0);
  expect(game.resolveNight()).toEqual({ kind: "Killed", killed: 0 });
  expect(game.state().phase).toBe("Hunter");
  expect(game.state().pendingActors).toEqual([0]);
  expect(game.state().isOver).toBe(false);
  const before = game.state();
  expect(grab(() => game.hunterAction(1, 2)).code).toBe("NotPendingHunter");
  expect(grab(() => game.hunterAction(0, 0)).code).toBe("PlayerNotAlive");
  expect(game.state()).toEqual(before);
  game.hunterAction(0, 1);
  expect(game.state().winner).toBe("Villagers");
  expect(grab(() => game.hunterAction(0, 2)).code).toBe("GameOver");
});

test("the Seer may inspect once on Day 1 alongside the vote", () => {
  const game = Game.withRoles(["Seer", "Werewolf", "Doctor", "Villager", "Villager"]);
  const before = game.state();
  expect(before).toMatchObject({
    phase: "Day",
    round: 1,
    pendingActors: [0, 1, 2, 3, 4],
    pendingInspectors: [0],
  });
  for (const call of [() => game.nightAction(1, 3), () => game.doctorAction(2, 3), () => game.resolveNight()])
    expect(grab(call).code).toBe("WrongPhase");
  expect(grab(() => game.seerAction(1, 3)).code).toBe("NotASeer");
  expect(grab(() => game.seerAction(0, 99)).code).toBe("UnknownPlayer");
  expect(game.state()).toEqual(before);
  game.vote(3, 1);
  const result = game.seerAction(0, 1);
  expect(result).toEqual({ seer: 0, target: 1, round: 1, phase: "Day", isWerewolf: true });
  expect(game.state()).toMatchObject({
    phase: "Day",
    round: 1,
    pendingActors: [0, 1, 2, 4],
    pendingInspectors: [],
    inspections: [result],
    votes: [{ voter: 3, target: 1 }],
  });
  expect(grab(() => game.seerAction(0, 2)).code).toBe("AlreadyActed");
  expect(game.state().players.every((p) => p.alive)).toBe(true);
});

test("an unused Day 1 inspection is skipped and later days allow none", () => {
  for (const role of ["Villager", "Seer"] as const) {
    const game = Game.withRoles([role, "Werewolf", "Doctor", "Villager", "Villager", "Villager"]);
    expect(game.state().pendingInspectors).toEqual(role === "Seer" ? [0] : []);
    const players = game.state().players;
    for (const player of players) game.vote(player.id, 5);
    game.resolveDay();
    expect(game.state()).toMatchObject({ phase: "Night", round: 1, inspections: [] });
    if (role === "Seer") expect(game.seerAction(0, 1)).toMatchObject({ round: 1, phase: "Night" });
    game.doctorAction(2, 3);
    game.nightAction(1, 4);
    game.resolveNight();
    expect(game.state()).toMatchObject({ phase: "Day", round: 2, pendingInspectors: [] });
    expect(grab(() => game.seerAction(0, 1)).code).toBe("WrongPhase");
  }
});

test("special roles cross the binding with final actions, private results, and a saved seat zero", () => {
  const game = Game.withRoles(["Doctor", "Werewolf", "Seer", "Villager", "Villager"]);
  expect(game.state().aliveVillagers).toBe(4);
  reachNight(game);
  expect(game.state().pendingActors).toEqual([0, 1, 2]);
  const before = game.state();
  expect(grab(() => game.doctorAction(3, 0)).code).toBe("NotADoctor");
  expect(grab(() => game.seerAction(3, 0)).code).toBe("NotASeer");
  expect(game.state()).toEqual(before);
  game.nightAction(1, 0);
  game.doctorAction(0, 0);
  expect(game.state().doctorPicks).toEqual([{ voter: 0, target: 0 }]);
  expect(grab(() => game.resolveNight()).code).toBe("ActionsIncomplete");
  const result = game.seerAction(2, 1);
  expect(result).toEqual({ seer: 2, target: 1, round: 1, phase: "Night", isWerewolf: true });
  expect(game.state().inspections).toEqual([
    { seer: 2, target: 0, round: 1, phase: "Day", isWerewolf: false },
    result,
  ]);
  expect(grab(() => game.seerAction(2, 3)).code).toBe("AlreadyActed");
  expect(grab(() => game.doctorAction(0, 3)).code).toBe("AlreadyActed");
  expect(game.resolveNight()).toEqual({ kind: "Saved", saved: 0 });
  expect(game.state().doctorPicks).toEqual([]);
  expect(game.state().players.filter((p) => p.alive).length).toBe(4);
  expect(game.state().round).toBe(2);
});
