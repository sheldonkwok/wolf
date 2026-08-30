// Ported from the old Rust CLI's #[cfg(test)] block: the bot heuristics and the
// PRNG calibration, as statistical sweeps over fixed seeds.

import { expect, test } from "bun:test";

import { pick, randomLivingOther, randomLivingVillager, villagerBotVote } from "./bots.js";
import { Game, Rng, type GameState } from "./engine.js";

// Wolves at seats 0 and 5, villagers elsewhere — no one eliminated.
function roster(): GameState {
  return Game.withRoles([
    "Werewolf", "Villager", "Villager", "Villager", "Villager", "Werewolf", "Villager",
  ]).state();
}

test("pack pick is never a wolf", () => {
  const state = roster();
  const rng = new Rng(1n);
  for (let n = 0; n < 1000; n++) {
    const target = randomLivingVillager(state, rng);
    expect(state.players[target]!.role).toBe("Villager");
  }
});

test("randomLivingOther excludes self and stays alive", () => {
  const state = roster();
  const rng = new Rng(2n);
  for (let n = 0; n < 1000; n++) {
    const t = randomLivingOther(state, rng, 3);
    expect(t).not.toBe(3);
    expect(state.players[t]!.alive).toBe(true);
  }
});

test("villager bot with no lead votes a living non-self", () => {
  const state = roster();
  const rng = new Rng(7n);
  for (let n = 0; n < 1000; n++) {
    const t = villagerBotVote(state, rng, null, 2);
    expect(t).not.toBe(2);
    expect(state.players[t]!.alive).toBe(true);
  }
});

test("villager bot follows the human lead most of the time", () => {
  const state = roster();
  const rng = new Rng(42n);
  const n = 4000;
  let copied = 0;
  for (let i = 0; i < n; i++) {
    if (villagerBotVote(state, rng, 1, 3) === 1) copied++;
  }
  const pct = Math.floor((copied * 100) / n);
  expect(pct).toBeGreaterThanOrEqual(60);
  expect(pct).toBeLessThanOrEqual(80);
});

test("chance is roughly calibrated", () => {
  const rng = new Rng(99n);
  const n = 10_000;
  let hits = 0;
  for (let i = 0; i < n; i++) if (rng.chance(66)) hits++;
  const pct = Math.floor((hits * 100) / n);
  expect(pct).toBeGreaterThanOrEqual(60);
  expect(pct).toBeLessThanOrEqual(72);
});

test("pick draws the below(len) element", () => {
  const rng = new Rng(123n);
  const pool = [10, 20, 30, 40];
  for (let i = 0; i < 200; i++) expect(pool).toContain(pick(rng, pool));
});
