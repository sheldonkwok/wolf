// Ported from the old Rust CLI's #[cfg(test)] block: the bot heuristics and the
// PRNG calibration, as statistical sweeps over fixed seeds.

import { expect, spyOn, test } from "bun:test";

import {
  botDayVotes,
  botNightActions,
  botWitchAction,
  livingIds,
  pick,
  randomLivingOther,
  randomLivingVillager,
  villagerBotVote,
} from "./bots.js";
import { Game, type GameState, Rng } from "./engine.js";

// Wolves at seats 0 and 5, villagers elsewhere — no one eliminated.
function roster(): GameState {
  return Game.withRoles([
    "Werewolf",
    "Villager",
    "Villager",
    "Villager",
    "Villager",
    "Werewolf",
    "Villager",
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

test("wolf targets include doctors and seers on the village team", () => {
  const state = Game.withRoles(["Werewolf", "Doctor", "Seer", "Villager", "Villager"]).state();
  const rng = new Rng(42n);
  const targets = new Set(Array.from({ length: 100 }, () => randomLivingVillager(state, rng)));
  expect(targets).toEqual(new Set([1, 2, 3, 4]));
});

test("wolf targets include the witch, and an all-bot table plays her legally to the end", () => {
  const start = Game.withRoles(["Werewolf", "Witch", "Hunter", "Villager", "Villager"]).state();
  const targets = new Set(Array.from({ length: 100 }, () => randomLivingVillager(start, new Rng(7n))));
  expect([...targets].every((id) => id !== 0)).toBe(true);

  const everyone = () => true;
  const used = { heal: 0, poison: 0, pass: 0, blindTurns: 0, games: 0 };
  for (let seed = 0n; seed < 300n; seed++) {
    const game = Game.withRoles([
      "Werewolf",
      "Werewolf",
      "Witch",
      "Doctor",
      "Seer",
      "Hunter",
      "Villager",
      "Villager",
    ]);
    const rng = new Rng(seed);
    for (let step = 0; !game.state().isOver; step++) {
      expect(step).toBeLessThan(200);
      const state = game.state();
      if (state.phase === "Hunter") game.hunterAction(state.pendingActors[0]!, pick(rng, livingIds(state)));
      else if (state.phase === "Day") {
        botDayVotes(game, rng, everyone, null, () => {});
        game.resolveDay();
      } else {
        const witchTurn =
          state.pendingActors.length === 1 && state.players[state.pendingActors[0]!]!.role === "Witch";
        // Any illegal bot choice would throw here.
        botNightActions(game, rng, everyone);
        const after = game.state();
        if (witchTurn) {
          const healed = state.healAvailable && !after.healAvailable;
          const poisoned = state.poisonAvailable && !after.poisonAvailable;
          expect(healed && poisoned).toBe(false);
          // A blind witch can never heal.
          if (state.witchVictim === undefined) {
            used.blindTurns++;
            expect(healed).toBe(false);
          }
          used[healed ? "heal" : poisoned ? "poison" : "pass"]++;
          expect(after.pendingActors).toEqual([]);
        }
        const night = game.resolveNight();
        if (night.kind === "Dawn" && night.deaths.includes(2)) expect(game.isAlive(2)).toBe(false);
      }
    }
    used.games++;
  }
  expect(used.heal).toBeGreaterThan(50);
  expect(used.heal).toBeLessThanOrEqual(used.games);
  expect(used.poison).toBeGreaterThan(20);
  expect(used.poison).toBeLessThanOrEqual(used.games);
  expect(used.pass).toBeGreaterThan(50);
  expect(used.blindTurns).toBeGreaterThan(20);
});

test("a bot witch never poisons herself and only heals a victim she can see", () => {
  const game = Game.withRoles(["Werewolf", "Witch", "Villager", "Villager", "Villager"]);
  for (const voter of [0, 1, 2, 3, 4]) game.vote(voter, (voter + 1) % 5);
  game.resolveDay();
  game.nightAction(0, 2);
  expect(game.resolveNight()).toEqual({ kind: "AwaitingWitch" });
  const state = game.state();
  const heal = spyOn(game, "witchHeal").mockImplementation(() => {});
  const poison = spyOn(game, "witchPoison").mockImplementation(() => {});
  const pass = spyOn(game, "witchPass").mockImplementation(() => {});
  const rng = new Rng(11n);
  for (let n = 0; n < 2000; n++) botWitchAction(game, state, rng, 1);
  expect(heal.mock.calls.length + poison.mock.calls.length + pass.mock.calls.length).toBe(2000);
  expect(heal.mock.calls.length).toBeGreaterThan(800);
  expect(poison.mock.calls.length).toBeGreaterThan(100);
  expect(pass.mock.calls.length).toBeGreaterThan(500);
  expect(poison.mock.calls.every(([witch, target]) => witch === 1 && [0, 2, 3, 4].includes(target))).toBe(
    true,
  );
  heal.mockClear();
  for (let n = 0; n < 500; n++) botWitchAction(game, { ...state, witchVictim: undefined }, rng, 1);
  expect(heal).not.toHaveBeenCalled();
  poison.mockClear();
  for (let n = 0; n < 500; n++)
    botWitchAction(game, { ...state, witchVictim: undefined, poisonAvailable: false }, rng, 1);
  expect(poison).not.toHaveBeenCalled();
});
