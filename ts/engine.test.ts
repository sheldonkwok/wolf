// The napi boundary: a full seeded game to a winner, and every GameError code
// surfacing as a typed throw.

import { expect, test } from "bun:test";

import {
  attempt,
  Game,
  GameError,
  Rng,
  normalizeDay,
  normalizeNight,
  timeSeed,
} from "./engine.js";

test("withSeed is reproducible and matches the Rust deal", () => {
  // Seed 100 / 7 players deals the wolf to seat 5, as the Rust CLI does.
  const a = Game.withSeed(7, 100n).state();
  const b = Game.withSeed(7, 100n).state();
  expect(a).toEqual(b);
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

test("a full game plays through to a villager win", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);

  game.nightAction(0, 1);
  const night = normalizeNight(game.resolveNight());
  expect(night).toEqual({ kind: "Killed", killed: 1 });
  expect(game.state().phase).toBe("Day");

  for (const voter of [0, 2, 3, 4]) game.vote(voter, voter === 0 ? 2 : 0);
  const day = normalizeDay(game.resolveDay());
  expect(day).toEqual({ kind: "Eliminated", eliminated: 0 });

  const end = game.state();
  expect(end.isOver).toBe(true);
  expect(end.winner).toBe("Villagers");
});

test("a split pack resolves to NoConsensus and stays in Night", () => {
  const game = Game.withRoles(["Werewolf", "Werewolf", "Villager", "Villager", "Villager"]);
  game.nightAction(0, 2);
  game.nightAction(1, 3);
  const night = normalizeNight(game.resolveNight());
  expect(night.kind).toBe("NoConsensus");
  if (night.kind === "NoConsensus") expect(night.targets.sort()).toEqual([2, 3]);
  expect(game.state().phase).toBe("Night");
});

test("unknown player throws UnknownPlayer", () => {
  const game = Game.withSeed(5, 1n);
  expect(() => game.roleOf(99)).toThrow("UnknownPlayer");
  try {
    attempt(() => game.roleOf(99));
    throw new Error("expected a throw");
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe("UnknownPlayer");
  }
});

test("a day command during Night throws WrongPhase", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  const err = grab(() => game.vote(0, 1));
  expect(err.code).toBe("WrongPhase");
});

test("voting twice throws AlreadyActed", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  game.nightAction(0, 1);
  game.resolveNight();
  game.vote(2, 0);
  expect(grab(() => game.vote(2, 3)).code).toBe("AlreadyActed");
});

test("resolving the night early throws ActionsIncomplete", () => {
  const game = Game.withRoles(["Werewolf", "Villager", "Villager", "Villager", "Villager"]);
  expect(grab(() => game.resolveNight()).code).toBe("ActionsIncomplete");
});

test("too few players throws TooFewPlayers", () => {
  expect(grab(() => Game.withSeed(3, 1n)).code).toBe("TooFewPlayers");
});

// Run a call that must throw and return it as a typed GameError.
function grab(call: () => unknown): GameError {
  try {
    call();
  } catch (thrown) {
    return GameError.fromThrown(thrown);
  }
  throw new Error("expected the call to throw");
}
