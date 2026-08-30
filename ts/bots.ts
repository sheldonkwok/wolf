// The bot opponents, ported from the old Rust CLI. Every function reads a
// GameState snapshot and draws from the shared Rng in the same order the engine's
// SplitMix64 was consumed before, so a seed reproduces an identical game.

import type { GameState, Rng } from "./engine.js";

export function livingIds(state: GameState): number[] {
  return state.players.filter((p) => p.alive).map((p) => p.id);
}

export function livingWolves(state: GameState): number[] {
  return state.players.filter((p) => p.alive && p.role === "Werewolf").map((p) => p.id);
}

export function livingVillagers(state: GameState): number[] {
  return state.players.filter((p) => p.alive && p.role === "Villager").map((p) => p.id);
}

export function isWolf(state: GameState, id: number): boolean {
  return state.players[id]?.role === "Werewolf";
}

// Mirrors SplitMix64::choose: element at below(len).
export function pick<T>(rng: Rng, pool: T[]): T {
  return pool[rng.below(pool.length)] as T;
}

// The pack's fallback pick: a random living villager, or any living player if none.
export function randomLivingVillager(state: GameState, rng: Rng): number {
  let pool = livingVillagers(state);
  if (pool.length === 0) pool = livingIds(state);
  return pick(rng, pool);
}

// A random living player other than `exclude`, or `exclude` if nobody else is left.
export function randomLivingOther(state: GameState, rng: Rng, exclude: number): number {
  const pool = livingIds(state).filter((id) => id !== exclude);
  return pool.length ? pick(rng, pool) : exclude;
}

// A villager bot's day vote: follow the human's lead 66% of the time, else at random.
export function villagerBotVote(
  state: GameState,
  rng: Rng,
  myVote: number | null,
  bot: number,
): number {
  if (myVote !== null && rng.chance(66)) return myVote;
  return randomLivingOther(state, rng, bot);
}
