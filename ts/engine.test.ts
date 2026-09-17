// Exercise the public wrapper against the native engine and malformed boundary results.

import { expect, spyOn, test } from "bun:test";
import { Game as NativeGame } from "./native/index.js";

import {
  Game,
  GameError,
  Rng,
  timeSeed,
} from "./engine.js";

function reachNight(game: Game): void {
  const players = game.state().players.filter(p => p.alive);
  for (const player of players.slice(0, game.state().readinessRequired)) game.readyToVote(player.id);
  for (const player of players) game.vote(player.id, player.id);
  expect(game.resolveDay().kind).toBe("NoElimination");
  expect(game.state().phase).toBe("Night");
  expect(game.state().round).toBe(1);
}

test("withSeed is reproducible and matches the Rust deal", () => {
  // Seed 100 / 7 players deals the wolf to seat 5, as the Rust CLI does.
  const a = Game.withSeed(7, 100n).state();
  const b = Game.withSeed(7, 100n).state();
  expect(a).toEqual(b);
  expect(a.phase).toBe("Day");
  expect(a.round).toBe(1);
  expect(a.players.every(p => p.alive)).toBe(true);
  expect(a.votingOpen).toBe(false);
  expect(a.readyPlayers).toEqual([]);
  expect(a.pendingActors).toEqual(a.players.map(p => p.id));
  expect(a.players.filter((p) => p.role === "Werewolf").map((p) => p.id)).toEqual([5]);
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

test("Day 1 gates voting and can end in a villager win before night", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  expect(game.state().phase).toBe("Day");
  const before = game.state();
  expect(grab(() => game.nightAction(0, 1)).code).toBe("WrongPhase");
  expect(grab(() => game.resolveNight()).code).toBe("WrongPhase");
  expect(grab(() => game.vote(0, 1)).code).toBe("VotingNotOpen");
  expect(grab(() => game.resolveDay()).code).toBe("VotingNotOpen");
  expect(game.state()).toEqual(before);

  for (const player of [0, 1, 2]) game.readyToVote(player);
  for (const voter of [0, 1, 2, 3, 4]) game.vote(voter, voter === 0 ? 2 : 0);
  const day = game.resolveDay();
  expect(day).toEqual({ kind: "Eliminated", eliminated: 0 });

  const end = game.state();
  expect(end.isOver).toBe(true);
  expect(end.winner).toBe("Villagers");
  expect(end.round).toBe(1);
  expect(end.players.filter(p => p.alive).length).toBe(4);
});

test("a split pack resolves to NoConsensus and stays in Night", () => {
  const game = Game.withRoles(["Werewolf", "Werewolf", "Villager", "Villager", "Villager"]);
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

test("readiness crosses the binding, gates votes, and clears after resolution", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  expect(grab(() => game.readyToVote(0)).code).toBe("WrongPhase");
  game.nightAction(0, 1);
  game.resolveNight();
  expect(game.state().readinessRequired).toBe(3);
  expect(grab(() => game.readyToVote(1)).code).toBe("PlayerNotAlive");
  expect(grab(() => game.readyToVote(99)).code).toBe("UnknownPlayer");
  game.readyToVote(0);
  expect(grab(() => game.readyToVote(0)).code).toBe("AlreadyActed");
  game.readyToVote(2);
  expect(game.state().readyPlayers).toEqual([0, 2]);
  expect(game.state().votingOpen).toBe(false);
  expect(game.state().pendingActors).toEqual([3, 4]);
  expect(grab(() => game.vote(3, 0)).code).toBe("VotingNotOpen");
  expect(grab(() => game.resolveDay()).code).toBe("VotingNotOpen");
  game.readyToVote(3);
  expect(game.state().votingOpen).toBe(true);
  expect(game.state().phase).toBe("Day");
  expect(game.state().pendingActors).toEqual([0, 2, 3, 4]);
  expect(grab(() => game.readyToVote(4)).code).toBe("VotingAlreadyOpen");
  for (const player of [0, 2, 3, 4]) game.vote(player, player);
  game.resolveDay();
  expect(game.state().readyPlayers).toEqual([]);
  expect(game.state().votingOpen).toBe(false);
  game.nightAction(0, 2);
  game.resolveNight();
  expect(game.state().readinessRequired).toBe(2);
  expect(game.state().votingOpen).toBe(false);
});

test("unknown player throws UnknownPlayer", () => {
  const game = Game.withSeed(5, 1n);
  const error = grab(() => game.roleOf(99));
  expect(error.code).toBe("UnknownPlayer");
  expect(error.message).toBe("no such player: P99");
});

test("a day command during Night throws WrongPhase", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  const err = grab(() => game.vote(0, 1));
  expect(err.code).toBe("WrongPhase");
});

test("voting twice throws AlreadyActed", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  game.nightAction(0, 1);
  game.resolveNight();
  for (const player of [0, 2, 3]) game.readyToVote(player);
  game.vote(2, 0);
  expect(grab(() => game.vote(2, 3)).code).toBe("AlreadyActed");
});

test("resolving the night early throws ActionsIncomplete", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  reachNight(game);
  expect(grab(() => game.resolveNight()).code).toBe("ActionsIncomplete");
});

test("too few players throws TooFewPlayers", () => {
  expect(grab(() => new Game(3)).code).toBe("TooFewPlayers");
  expect(grab(() => Game.withSeed(3, 1n)).code).toBe("TooFewPlayers");
  expect(grab(() => Game.withRoles(["Villager"])).code).toBe("TooFewPlayers");
});

test("all constructors produce usable wrapper instances", () => {
  for (const game of [new Game(5), Game.withSeed(5, 1n), Game.withRoles([
    "Werewolf", "Villager", "Villager", "Villager", "Villager",
  ])]) {
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
  for (const id of [0, 2, 3]) game.readyToVote(id);
  for (const id of [0, 2, 3, 4]) game.vote(id, 0);
  expect(game.resolveDay()).toEqual({ kind: "Eliminated", eliminated: 0 });
  expect(grab(() => game.readyToVote(2)).code).toBe("GameOver");
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
    code: "UnknownPlayer", message: "no such player: P99",
  });
  for (const thrown of [new Error("Unexpected: detail"), "plain failure", null]) {
    expect(GameError.fromThrown(thrown)).toMatchObject({
      code: "Unknown", message: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
});

const malformedResults: Array<["resolveDay" | "resolveNight", unknown]> = [
  ["resolveDay", { kind: "Eliminated" }],
  ["resolveDay", { kind: "Eliminated", eliminated: null }],
  ["resolveDay", { kind: "Eliminated", eliminated: -1 }],
  ["resolveDay", { kind: "Eliminated", eliminated: 1.5 }],
  ["resolveDay", { kind: "Unexpected" }],
  ["resolveDay", null],
  ["resolveNight", { kind: "Killed", targets: [] }],
  ["resolveNight", { kind: "Killed", killed: "0", targets: [] }],
  ["resolveNight", { kind: "Killed", killed: NaN, targets: [] }],
  ["resolveNight", { kind: "Killed", killed: Number.MAX_SAFE_INTEGER + 1, targets: [] }],
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
