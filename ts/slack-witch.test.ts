// The Witch in Slack: a private turn after the pack locks, single-use potions, and cause-free morning reports.

import { afterEach, expect, spyOn, test } from "bun:test";
import type { App } from "@slack/bolt";
import { Game, type Role } from "./engine.js";
import { Lobby } from "./lobby.js";
import { SlackGame, type SlackInput, type SlackMessage } from "./slack/game.js";
import { choiceNameResolver, messageBlocks } from "./slackbot.js";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

class FixedLobby extends Lobby {
  override start(host: string) {
    return this.startWithSeed(host, 0n);
  }
}

// Wolves 0 and 1, Witch 2, Doctor 3, Seer 4, Hunter 5, Villagers 6 and 7.
const FULL: Role[] = ["Werewolf", "Werewolf", "Witch", "Doctor", "Seer", "Hunter", "Villager", "Villager"];
const HIDDEN = /witch|potion|poison|heal/i;

// A started game with exactly `roles`; seats past `humans` are dev bots.
function table(roles: Role[], humans = roles.length, seed = 1n) {
  spies.push(spyOn(Game, "withSeed").mockImplementation(() => Game.withRoles(roles)));
  const lobby = new FixedLobby();
  const dev = humans < roles.length;
  const bot = new SlackGame("CGAME", lobby, { dev, seed });
  let sequence = 0;
  const messages: SlackMessage[] = [];
  const receive = (input: Omit<SlackInput, "id"> & { text?: string; value?: string }) => {
    const output = bot.handle({ ...input, id: `event-${sequence++}` } as SlackInput);
    messages.push(...output);
    return output;
  };
  const command = (text: string, seat = 0) =>
    receive({ kind: "mention", text, user: `U${seat}`, channel: "CGAME" });
  const dm = (seat: number) =>
    receive({ kind: "dm", text: "status", user: `U${seat}`, channel: `DU${seat}` });
  const send = (seat: number, value: string) =>
    receive({ kind: "choice", user: `U${seat}`, channel: `DU${seat}`, value });
  const prompt = (seat: number) => dm(seat).find((m) => m.choices);
  const choose = (seat: number, target: number | "heal" | "pass") => {
    const choice = prompt(seat)?.choices?.find((c) => c.value.endsWith(`:${target}`));
    if (!choice) throw new Error(`No option ${target} for seat ${seat}`);
    return send(seat, choice.value);
  };
  const state = () => lobby.game!.state();
  const living = () =>
    state()
      .players.filter((p) => p.alive)
      .map((p) => p.id);
  // Everyone votes for the next living player, so the ballot ties and night begins.
  const tieDay = () => {
    const ids = living();
    let output: SlackMessage[] = [];
    for (const [index, voter] of ids.entries())
      output = command(`vote <@U${ids[(index + 1) % ids.length]}>`, voter);
    expect(state().phase).toBe("Night");
    return output;
  };
  // The pack, Doctor, and Seer act in turn; returns what the final action sent.
  const dusk = (attack: number, protect?: number) => {
    let output: SlackMessage[] = [];
    for (const p of state().players) {
      if (!p.alive) continue;
      if (p.role === "Werewolf") output = choose(p.id, attack);
      if (p.role === "Doctor") output = choose(p.id, protect!);
      if (p.role === "Seer") output = choose(p.id, attack);
    }
    return output;
  };
  for (let seat = 0; seat < humans; seat++) command("join", seat);
  const start = command("start");
  return { bot, lobby, messages, start, receive, command, dm, send, prompt, choose, state, tieDay, dusk };
}

const channel = (output: SlackMessage[]) =>
  output.filter((m) => m.destination === "channel").map((m) => m.text);

test("the Witch is prompted privately only after the pack, Doctor, and Seer have acted", () => {
  const t = table(FULL);
  expect(t.start.find((m) => m.user === "U2" && m.text.includes("You are Player"))?.text).toContain(
    "a Witch. The potion-maker. Holds one healing potion and one poison for the whole game.",
  );
  const night = t.tieDay();
  expect(
    night
      .filter((m) => m.choices)
      .map((m) => m.user)
      .sort(),
  ).toEqual(["U0", "U1", "U3", "U4"]);
  const waiting = t.dm(2);
  expect(waiting.some((m) => m.choices)).toBe(false);
  expect(waiting.map((m) => m.text)).toContain(
    "Your Night 1 turn comes after the Werewolves choose. You will get a dropdown then.",
  );
  expect(waiting.map((m) => m.text)).toContain("Healing potion: ready. Poison: ready.");
  const publicStatus = t.command("status");
  const wolfValue = t.prompt(0)!.choices!.find((c) => c.value.endsWith(":7"))!.value;

  const locked = t.dusk(6, 7);
  expect(t.state()).toMatchObject({ phase: "Night", round: 1, pendingActors: [2], witchVictim: 6 });
  expect(channel(locked)).toEqual([]);
  const prompts = locked.filter((m) => m.choices);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({ destination: "dm", user: "U2" });
  expect(prompts[0]!.text).toStartWith(
    "Night 1: The Werewolves attacked <@U6>. Choose one: heal them, poison another player, do nothing. You may use only one potion per night, and your choice is final.",
  );
  const [heal, pass, ...poisons] = prompts[0]!.choices!;
  expect(heal).toEqual({ label: "Heal the attacked player", value: heal!.value });
  expect(pass).toEqual({ label: "Do nothing", value: pass!.value });
  expect(poisons.map((c) => c.slackUser)).toEqual(["U0", "U1", "U3", "U4", "U5", "U6", "U7"]);
  expect(poisons.every((c) => c.prefix === "Poison " && c.label === c.slackUser)).toBe(true);

  // Nothing public changes while the village waits on her, and nobody else learns anything.
  expect(t.command("status")).toEqual(publicStatus);
  expect(publicStatus[0]!.text).not.toMatch(HIDDEN);
  for (const seat of [0, 1, 3, 4, 5, 6, 7]) {
    const status = t.dm(seat);
    expect(status.some((m) => m.choices)).toBe(false);
    expect(status.some((m) => /attacked|potion/i.test(m.text))).toBe(false);
  }
  expect(t.dm(0).map((m) => m.text)).toContain(
    "Your Night 1 action is recorded. Waiting for the remaining night actions.",
  );
  const recovered = t.dm(2);
  expect(recovered.map((m) => m.text)).toContain(
    "Your Night 1 action is still needed. Choose using the dropdown below.",
  );
  expect(recovered.find((m) => m.choices)?.choices).toEqual(prompts[0]!.choices);

  // Stale, borrowed, and forged choices change nothing.
  const before = t.state();
  const stem = pass!.value.replace(/pass$/, "");
  for (const [seat, value, error] of [
    [0, wolfValue, "expired"],
    [0, pass!.value, "belongs to another player"],
    [0, `${stem.replace("U2", "U0")}heal`, "expired"],
    [2, `${stem}2`, "cannot poison herself"],
    [2, `${stem}99`, "Unknown target"],
    [2, `${stem}pass:1`, "expired"],
    [2, `${stem}both`, "expired"],
  ] as const) {
    expect(t.send(seat, value)[0]?.text).toContain(error);
    expect(t.state()).toEqual(before);
  }

  const dawn = t.send(2, pass!.value);
  expect(dawn[0]).toEqual({ destination: "dm", user: "U2", text: "You kept your potions tonight." });
  expect(channel(dawn)[0]).toBe("<@U6> was eliminated during the night. Their role was Villager.");
  expect(channel(dawn)[1]).toStartWith("Day 2.");
  expect(channel(dawn).join("\n")).not.toMatch(HIDDEN);
  expect(t.state()).toMatchObject({ phase: "Day", round: 2, healAvailable: true, poisonAvailable: true });
  expect(t.send(2, pass!.value)[0]?.text).toContain("expired");
});

test("healing saves the target, then leaves the Witch blind with only her poison", () => {
  const t = table(FULL);
  t.tieDay();
  t.dusk(6, 7);
  const healed = t.choose(2, "heal");
  expect(healed[0]).toEqual({
    destination: "dm",
    user: "U2",
    text: "You used your healing potion on the attacked player. It is now spent.",
  });
  expect(channel(healed)[0]).toBe(
    "The Werewolves attacked <@U6>, but they were saved! No one was eliminated.",
  );
  expect(t.state().players.every((p) => p.alive)).toBe(true);
  expect(t.state()).toMatchObject({ phase: "Day", round: 2, healAvailable: false, poisonAvailable: true });

  t.tieDay();
  expect(t.dm(2).map((m) => m.text)).toContain("Healing potion: spent. Poison: ready.");
  const locked = t.dusk(6, 7);
  expect(t.state().witchVictim).toBeUndefined();
  const prompt = locked.find((m) => m.choices)!;
  expect(prompt.user).toBe("U2");
  expect(prompt.text).toStartWith(
    "Night 2: Your healing potion is spent, so you are not told who was attacked. Choose one: poison another player, do nothing.",
  );
  expect(prompt.text.split("\n")[0]).not.toContain("<@U");
  expect(prompt.choices!.map((c) => c.label)).toEqual([
    "Do nothing",
    "U0",
    "U1",
    "U3",
    "U4",
    "U5",
    "U6",
    "U7",
  ]);
  const before = t.state();
  const forged = prompt.choices![0]!.value.replace(/pass$/, "heal");
  expect(t.send(2, forged)[0]?.text).toContain("already used that potion");
  expect(t.state()).toEqual(before);

  // Poison adds a second elimination; the report gives roles but never causes.
  const poisoned = t.choose(2, 0);
  expect(poisoned[0]).toEqual({
    destination: "dm",
    user: "U2",
    text: "You poisoned <@U0>. Your poison is now spent.",
  });
  expect(channel(poisoned).slice(0, 2)).toEqual([
    "<@U0> was eliminated during the night. Their role was Werewolf.",
    "<@U6> was eliminated during the night. Their role was Villager.",
  ]);
  expect(channel(poisoned)[2]).toStartWith("Day 3.");
  expect(channel(poisoned).join("\n")).not.toMatch(HIDDEN);
  expect(poisoned.filter((m) => m.text.startsWith("You were eliminated.")).map((m) => m.user)).toEqual([
    "U0",
    "U6",
  ]);
  expect(t.state()).toMatchObject({ healAvailable: false, poisonAvailable: false });

  // With both potions spent she has no turn: the night ends on the last ordinary action.
  t.tieDay();
  const empty = t.dm(2);
  expect(empty.map((m) => m.text)).toContain("You have no action to take on Night 3.");
  expect(empty.map((m) => m.text)).toContain("Healing potion: spent. Poison: spent.");
  expect(empty.some((m) => m.choices)).toBe(false);
  const dawn = t.dusk(7, 3);
  expect(dawn.some((m) => m.user === "U2" && m.choices)).toBe(false);
  expect(channel(dawn)[0]).toBe("<@U7> was eliminated during the night. Their role was Villager.");
  expect(t.state()).toMatchObject({ phase: "Day", round: 4 });
});

test("a protected target and a poisoned Hunter share one morning, and the Hunter still shoots", () => {
  const t = table(FULL);
  t.tieDay();
  t.dusk(6, 6);
  const dawn = t.choose(2, 5);
  expect(channel(dawn)).toEqual([
    "The Werewolves attacked <@U6>, but they were saved!",
    "<@U5> was eliminated during the night. Their role was Hunter.",
    "The Hunter has a final shot. Play pauses until they choose a target in their DMs.",
  ]);
  expect(t.state()).toMatchObject({ phase: "Hunter", round: 1, pendingActors: [5], poisonAvailable: false });
  expect(dawn.find((m) => m.user === "U5" && !m.choices)?.text).toStartWith(
    "You were eliminated, but you must take your final shot.",
  );
  expect(dawn.filter((m) => m.choices).map((m) => m.user)).toEqual(["U5"]);

  // The Hunter takes the Witch with them, so later nights never wait on her.
  const shot = t.choose(5, 2);
  expect(channel(shot)[0]).toBe("<@U2> was eliminated by the Hunter's final shot. Their role was Witch.");
  expect(t.state()).toMatchObject({ phase: "Day", round: 2, healAvailable: true });
  t.tieDay();
  expect(t.dm(2).some((m) => m.choices)).toBe(false);
  const next = t.dusk(7, 3);
  expect(channel(next)[0]).toBe("<@U7> was eliminated during the night. Their role was Villager.");
  expect(t.state()).toMatchObject({ phase: "Day", round: 3 });
});

test("an attacked Witch is told so and may heal herself or strike back", () => {
  for (const choice of ["heal", 0] as const) {
    const t = table(FULL);
    t.tieDay();
    const prompt = t.dusk(2, 7).find((m) => m.choices)!;
    expect(prompt.text).toStartWith(
      "Night 1: The Werewolves attacked you. Choose one: heal yourself, poison another player, do nothing.",
    );
    expect(prompt.choices!.some((c) => c.slackUser === "U2")).toBe(false);
    const dawn = t.choose(2, choice);
    if (choice === "heal") {
      expect(channel(dawn)[0]).toBe(
        "The Werewolves attacked <@U2>, but they were saved! No one was eliminated.",
      );
      expect(t.state().players.every((p) => p.alive)).toBe(true);
    } else {
      expect(channel(dawn).slice(0, 2)).toEqual([
        "<@U0> was eliminated during the night. Their role was Werewolf.",
        "<@U2> was eliminated during the night. Their role was Witch.",
      ]);
      expect(dawn.findLast((m) => m.user === "U2")?.text).toStartWith("You were eliminated.");
    }
    expect(t.state()).toMatchObject({ phase: "Day", round: 2 });
  }
});

test("a Witch with only the healing potion left is offered no poison", () => {
  const t = table(FULL);
  t.tieDay();
  t.dusk(6, 3);
  expect(channel(t.choose(2, 7)).slice(0, 2)).toEqual([
    "<@U6> was eliminated during the night. Their role was Villager.",
    "<@U7> was eliminated during the night. Their role was Villager.",
  ]);
  t.tieDay();
  const prompt = t.dusk(4, 3).find((m) => m.choices)!;
  expect(prompt.text).toStartWith(
    "Night 2: The Werewolves attacked <@U4>. Choose one: heal them, do nothing. You may use only one potion",
  );
  expect(prompt.choices!.map((c) => c.label)).toEqual(["Heal the attacked player", "Do nothing"]);
  const before = t.state();
  const forged = prompt.choices![1]!.value.replace(/pass$/, "0");
  expect(t.send(2, forged)[0]?.text).toContain("already used that potion");
  expect(t.state()).toEqual(before);
  expect(channel(t.choose(2, "heal"))[0]).toBe(
    "The Werewolves attacked <@U4>, but they were saved! No one was eliminated.",
  );
});

test("a split pack chooses again before the Witch is shown anything", () => {
  const t = table(FULL);
  t.tieDay();
  t.choose(3, 7);
  t.choose(4, 0);
  t.choose(0, 6);
  const split = t.choose(1, 7);
  expect(split.filter((m) => m.text.startsWith("The pack disagreed")).map((m) => m.user)).toEqual([
    "U0",
    "U1",
  ]);
  expect(split.some((m) => m.user === "U2")).toBe(false);
  expect(t.state()).toMatchObject({ phase: "Night", pendingActors: [0, 1] });
  expect(t.state().witchVictim).toBeUndefined();
  expect(t.dm(2).some((m) => m.choices)).toBe(false);
  t.choose(0, 6);
  const locked = t.choose(1, 6);
  expect(locked.filter((m) => m.choices).map((m) => m.user)).toEqual(["U2"]);
  expect(t.state()).toMatchObject({ pendingActors: [2], witchVictim: 6 });
  // The Doctor's earlier protection of seat 7 is still in place, so the attack on seat 6 lands.
  expect(channel(t.choose(2, "pass"))[0]).toBe(
    "<@U6> was eliminated during the night. Their role was Villager.",
  );
});

test("a human Witch among dev bots is prompted as soon as the bots have acted", () => {
  const t = table(["Witch", "Werewolf", "Villager", "Doctor", "Villager"], 1);
  const game = t.lobby.game!;
  for (const voter of [1, 2]) game.vote(voter, 4);
  const night = t.command("vote 5");
  expect(t.state()).toMatchObject({ phase: "Night", round: 1, pendingActors: [0] });
  const prompt = night.findLast((m) => m.choices)!;
  expect(prompt.user).toBe("U0");
  expect(prompt.text).toStartWith("Night 1: The Werewolves attacked ");
  const poisons = prompt.choices!.slice(2);
  expect(poisons.map((c) => `${c.prefix}${c.label}`)).toEqual([
    "Poison Bot 1",
    "Poison Bot 2",
    "Poison Bot 3",
  ]);
  expect(poisons.every((c) => c.slackUser === undefined)).toBe(true);
  expect(night.every((m) => m.destination === "channel" || m.user === "U0")).toBe(true);
  // Poisoning the only wolf ends the game for the village.
  const dawn = t.choose(0, 1);
  expect(channel(dawn).some((text) => text.startsWith("Villagers win!"))).toBe(true);
  expect(t.lobby.game).toBeNull();
});

test("bot Witches never stall a dev game and produce every kind of morning", () => {
  const seen = { saved: 0, double: 0, savedAndDeath: 0, hunter: 0 };
  for (let seed = 0n; seed < 400n; seed++) {
    const t = table(["Villager", "Werewolf", "Witch", "Doctor", "Hunter"], 1, seed);
    let turns = 0;
    while (t.lobby.game) {
      if (++turns > 40) throw new Error(`Dev game ${seed} did not finish`);
      const state = t.state();
      // Bots resolve every night on their own, so the human only ever sees a day or their own death.
      expect(state.phase).toBe("Day");
      expect(state.players[0]!.alive).toBe(true);
      // Voting for themselves gets the human out early, leaving the special roles to play on.
      t.command("vote 1");
    }
    expect(t.messages.every((m) => m.destination === "channel" || m.user === "U0")).toBe(true);
    const publicText = channel(t.messages);
    // Role reveals are public; nothing else may hint at the Witch or her potions.
    const unrevealed = publicText.filter((text) => !text.includes("win!")).join("\n");
    expect(unrevealed.replace(/Their role was \w+\./g, "")).not.toMatch(HIDDEN);
    expect(publicText.some((text) => text.includes("win!"))).toBe(true);
    // Split the public log into mornings: everything between a night banner and the next phase banner.
    let morning: string[] | null = null;
    for (const text of publicText) {
      if (text.startsWith("Night ")) morning = [];
      else if (
        morning &&
        (text.startsWith("Day ") || text.includes("win!") || text.startsWith("The Hunter"))
      ) {
        const deaths = morning.filter((line) => line.includes("eliminated during the night")).length;
        const saved = morning.filter((line) => line.includes("but they were saved!")).length;
        expect(deaths + saved).toBeGreaterThan(0);
        expect(deaths).toBeLessThanOrEqual(2);
        expect(saved).toBeLessThanOrEqual(1);
        if (saved && !deaths) seen.saved++;
        if (saved && deaths) seen.savedAndDeath++;
        if (deaths === 2) seen.double++;
        if (text.startsWith("The Hunter")) seen.hunter++;
        morning = null;
      } else morning?.push(text);
    }
  }
  for (const [kind, count] of Object.entries(seen)) expect(`${kind}: ${count > 0}`).toBe(`${kind}: true`);
});

test("poison options keep their prefix when Slack names replace the labels", async () => {
  const t = table(FULL);
  t.tieDay();
  const prompt = t.dusk(6, 7).find((m) => m.choices)!;
  const resolve = choiceNameResolver({
    users: {
      info: async ({ user }: { user: string }) => ({ ok: true, user: { real_name: `Name ${user}` } }),
    },
  } as unknown as App["client"]);
  const named = await resolve(prompt);
  const blocks = messageBlocks(named)!;
  const options = (
    blocks[1] as { elements: Array<{ options: Array<{ text: { text: string }; value: string }> }> }
  ).elements[0]!.options;
  expect(options.map((option) => option.text.text)).toEqual([
    "Heal the attacked player",
    "Do nothing",
    ...[0, 1, 3, 4, 5, 6, 7].map((seat) => `Poison Name U${seat}`),
  ]);
  expect(options.map((option) => option.value)).toEqual(prompt.choices!.map((choice) => choice.value));
});
