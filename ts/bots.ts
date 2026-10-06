// The bot opponents, ported from the old Rust CLI. Every function reads a
// GameState snapshot and draws from the shared Rng in the same order the engine's
// SplitMix64 was consumed before, so a seed reproduces an identical game.

import type { Game, GameState, Rng } from "./engine.js";

export function livingIds(state: GameState): number[] {
  return state.players.filter((p) => p.alive).map((p) => p.id);
}

export function livingWolves(state: GameState): number[] {
  return state.players.filter((p) => p.alive && p.role === "Werewolf").map((p) => p.id);
}

export function livingVillagers(state: GameState): number[] {
  return state.players.filter((p) => p.alive && p.role !== "Werewolf").map((p) => p.id);
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
export function villagerBotVote(state: GameState, rng: Rng, myVote: number | null, bot: number): number {
  if (myVote !== null && rng.chance(66)) return myVote;
  return randomLivingOther(state, rng, bot);
}

// Whether the day can resolve: an early majority exists or every living player has voted.
export function ballotClosed(state: GameState): boolean {
  return state.majorityTarget != null || state.pendingActors.length === 0;
}

// A bot seer takes the optional Day 1 inspection; a human seer is left to choose.
export function botDayInspection(game: Game, rng: Rng, isBot: (seat: number) => boolean): void {
  const state = game.state();
  const seer = state.pendingInspectors[0];
  if (seer !== undefined && isBot(seer)) game.seerAction(seer, randomLivingOther(state, rng, seer));
}

// Cast bot day votes in seat order until the ballot closes; `lead` is the human vote villager bots may copy.
export function botDayVotes(
  game: Game,
  rng: Rng,
  isBot: (seat: number) => boolean,
  lead: number | null,
  onVote: (voter: number, target: number) => void,
): void {
  const state = game.state();
  const humansAlive = state.players.some((p) => p.alive && !isBot(p.id));
  const packLead = state.votes.find((v) => !isBot(v.voter) && isWolf(state, v.voter))?.target;
  const wolfTarget = packLead ?? randomLivingVillager(state, rng);
  for (const player of state.players) {
    if (!player.alive || !isBot(player.id)) continue;
    const target =
      !humansAlive || player.role === "Werewolf" ? wolfTarget : villagerBotVote(state, rng, lead, player.id);
    game.vote(player.id, target);
    onVote(player.id, target);
    if (ballotClosed(game.state())) break;
  }
}

// Submit every pending bot night action; bot wolves follow an existing pack pick before choosing their own.
export function botNightActions(game: Game, rng: Rng, isBot: (seat: number) => boolean): void {
  const state = game.state();
  const target = state.nightPicks[0]?.target ?? randomLivingVillager(state, rng);
  for (const seat of state.pendingActors) {
    if (!isBot(seat)) continue;
    switch (game.roleOf(seat)) {
      case "Doctor":
        game.doctorAction(seat, pick(rng, livingIds(state)));
        break;
      case "Seer":
        game.seerAction(seat, randomLivingOther(state, rng, seat));
        break;
      default:
        game.nightAction(seat, target);
    }
  }
}
