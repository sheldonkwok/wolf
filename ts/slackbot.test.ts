import { expect, test } from "bun:test";
import { type FinishedGame, openStats } from "./db/index.js";
import { gamePlayers, games } from "./db/schema.js";
import { Rng } from "./engine.js";
import { Lobby } from "./lobby.js";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackInput, type SlackMessage } from "./slack/game.js";
import { messageBlocks, slackArgs, slackChannel, slackConfig, slackErrorMessage } from "./slackbot.js";

class SeededLobby extends Lobby {
  constructor(private seed: bigint) {
    super();
  }
  override start(host: string) {
    return this.startWithSeed(host, this.seed);
  }
}

function table(
  count = 8,
  seed = 1n,
  dev = false,
  recordResult?: (result: FinishedGame) => void,
  autoOpening = true,
) {
  const lobby = new SeededLobby(seed);
  let now = 0;
  const bot = new SlackGame("CGAME", lobby, { dev, seed, recordResult, now: () => now });
  let sequence = 0;
  const messages: SlackMessage[] = [];
  const receive = (input: Omit<SlackInput, "id"> & { text?: string; value?: string }) => {
    const output = bot.handle({ ...input, id: `event-${sequence++}` } as SlackInput);
    messages.push(...output);
    return output;
  };
  const command = (text: string, user = "U0", channel = "CGAME") => {
    const output = receive({ kind: "mention", text, user, channel });
    if (autoOpening && text === "start" && lobby.game?.state().phase === "Opening") {
      const state = lobby.game.state();
      if (state.pendingActors.length)
        output.push(...choose(state.pendingActors[0]!, state.players.find((p) => p.role === "Werewolf")!.id));
      output.push(...tick(now + 120_000));
    }
    return output;
  };
  const dm = (user: string, text = "status") => receive({ kind: "dm", text, user, channel: `D${user}` });
  const value = (user: string, target: number) =>
    messages
      .findLast((m) => m.user === user && m.choices)
      ?.choices?.find((c) => c.label === `Player ${target + 1}`)?.value;
  const choose = (seat: number, target: number) => {
    const user = lobby.memberAt(seat)!.user;
    const choice = value(user, target);
    if (!choice) throw new Error(`No prompt for ${user} -> ${target}`);
    return receive({ kind: "choice", user, channel: `D${user}`, value: choice });
  };
  for (let seat = 0; seat < count; seat++) command("join", `U${seat}`);
  const vote = (seat: number, target: number) =>
    command(dev ? `vote ${target + 1}` : `vote <@U${target}>`, `U${seat}`);
  const setNow = (time: number) => {
    now = time;
  };
  const tick = (time: number) => {
    setNow(time);
    const output = bot.tick();
    messages.push(...output);
    return output;
  };
  return { bot, lobby, messages, receive, command, dm, choose, value, vote, tick, setNow };
}

function reachNight(t: ReturnType<typeof table>) {
  eliminate(t, t.lobby.game!.state().players.findLast((p) => p.alive && p.role === "Villager")!.id);
  expect(t.lobby.game!.state().phase).toBe("Night");
  expect(t.lobby.game!.state().round).toBe(1);
}

function morning(t: ReturnType<typeof table>) {
  const state = t.lobby.game!.state();
  const target = state.players.find((p) => p.alive && p.role !== "Werewolf" && p.role !== "Hunter")!.id;
  for (const actor of state.pendingActors) {
    const choice =
      state.players[actor]!.role === "Doctor"
        ? state.players.find((p) => p.alive && p.id !== target)!.id
        : target;
    t.choose(actor, choice);
  }
  return target;
}

function eliminate(t: ReturnType<typeof table>, target: number): SlackMessage[] {
  const state = t.lobby.game!.state();
  let output: SlackMessage[] = [];
  for (const player of state.players.filter((p) => p.alive).slice(0, state.majorityRequired)) {
    output = t.vote(player.id, target);
  }
  return output;
}

test("opening inspection is private, recoverable, and expires when Day 1 begins", () => {
  const t = table(8, 1n, false, undefined, false);
  const start = t.command("start");
  const game = t.lobby.game!;
  const before = game.state();
  expect(before.phase).toBe("Opening");
  expect(before.round).toBe(0);
  const seer = before.players.find((p) => p.role === "Seer")!.id;
  const wolf = before.players.find((p) => p.role === "Werewolf")!.id;
  const user = `U${seer}`;
  expect(before.pendingActors).toEqual([seer]);
  expect(start.filter((m) => m.choices).map((m) => m.user)).toEqual([user]);
  expect(start.some((m) => m.text.startsWith("Day 1."))).toBe(false);
  expect(t.command("status")[0]?.text).toContain("Opening before Day 1");
  expect(t.command("status")[0]?.text).not.toMatch(/<@U\d+>.*Seer|inspection:/);
  const status = t.dm(user);
  expect(status.some((m) => m.text.includes("opening inspection is still needed"))).toBe(true);
  expect(status.some((m) => m.choices)).toBe(true);
  for (const player of before.players.filter((p) => p.id !== seer)) {
    const other = t.dm(`U${player.id}`);
    expect(other.some((m) => m.choices)).toBe(false);
    expect(other.some((m) => m.text.includes("no opening action"))).toBe(true);
  }
  const value = t.value(user, wolf)!;
  expect(t.vote(wolf, seer)[0]?.text).toContain("requires Day");
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value })[0]?.text).toContain(
    "belongs",
  );
  expect(
    t.receive({ kind: "choice", user, channel: "DTEST", value: value.replace(/:\d+$/, ":999") })[0]?.text,
  ).toContain("Unknown target");
  expect(game.state()).toEqual(before);
  const input: SlackInput = { id: "opening-choice", kind: "choice", user, channel: "DTEST", value };
  const result = t.bot.handle(input);
  expect(result.find((m) => m.text.includes("opening inspection:"))).toEqual({
    destination: "dm",
    user,
    text: `Your opening inspection: <@U${wolf}> is a Werewolf.`,
  });
  expect(result.filter((m) => m.destination === "channel").every((m) => !m.text.includes("inspection"))).toBe(
    true,
  );
  expect(result.filter((m) => m.destination === "channel")).toEqual([]);
  expect(game.state().phase).toBe("Opening");
  expect(t.dm(user).some((m) => m.text.includes("opening inspection is recorded"))).toBe(true);
  expect(t.dm(user).some((m) => m.choices)).toBe(false);
  expect(t.receive({ kind: "choice", user, channel: "DTEST", value })[0]?.text).toContain("already acted");
  expect(t.tick(120_000).filter((m) => m.text.startsWith("Day 1. Discuss"))).toHaveLength(1);
  expect(t.tick(120_001)).toEqual([]);
  expect(game.state().phase).toBe("Day");
  expect(game.state().round).toBe(1);
  expect(game.state().players.every((p) => p.alive)).toBe(true);
  expect(t.bot.handle(input)).toEqual([]);
  expect(t.receive({ kind: "choice", user, channel: "DTEST", value })[0]?.text).toContain("expired");
  expect(t.dm(user).some((m) => m.text === `Opening inspection: <@U${wolf}> is a Werewolf.`)).toBe(true);
  expect(t.dm(user).some((m) => m.choices || m.text.includes("Night 0"))).toBe(false);
  expect(t.dm(`U${wolf}`).some((m) => m.text.includes("inspection:"))).toBe(false);
  reachNight(t);
  expect(t.receive({ kind: "choice", user, channel: "DTEST", value })[0]?.text).toContain("expired");
  expect(t.choose(seer, wolf).some((m) => m.text === `Your inspection: <@U${wolf}> is a Werewolf.`)).toBe(
    true,
  );
});

test("all dev openings wait for the timer whether Seer is absent, pending, or acted", () => {
  const publicStarts = new Set<string>();
  const publicStatuses = new Set<string>();
  const paths = new Set<string>();
  for (let seed = 0n; seed < 40n; seed++) {
    const t = table(1, seed, true, undefined, false);
    const start = t.command("start");
    const state = t.lobby.game!.state();
    const seer = state.players.find((p) => p.role === "Seer");
    const path = !seer ? "no-seer" : seer.id === 0 ? "human" : "bot";
    paths.add(path);
    expect(state.phase).toBe("Opening");
    expect(state.round).toBe(0);
    expect(state.inspections).toHaveLength(path === "bot" ? 1 : 0);
    expect(start.filter((m) => m.choices)).toHaveLength(path === "human" ? 1 : 0);
    expect(start.filter((m) => m.text.startsWith("Day 1. Discuss"))).toHaveLength(0);
    publicStarts.add(JSON.stringify(start.filter((m) => m.destination === "channel")));
    publicStatuses.add(JSON.stringify(t.command("status")));
    expect(t.tick(59_999)).toEqual([]);
    expect(t.tick(120_000).filter((m) => m.text.startsWith("Day 1. Discuss"))).toHaveLength(1);
    expect(t.lobby.game!.state().inspections).toHaveLength(path === "bot" ? 1 : 0);
    expect(start.every((m) => m.destination === "channel" || m.user === "U0")).toBe(true);
    expect(state.players.every((p) => p.alive)).toBe(true);
  }
  expect(paths).toEqual(new Set(["no-seer", "human", "bot"]));
  expect(publicStarts.size).toBe(1);
  expect(publicStatuses.size).toBe(1);
});

test("opening random duration includes both bounds independently of the roster", () => {
  for (const [seed, deadline] of [
    [88527n, 60_000],
    [56411n, 120_000],
  ] as const) {
    for (const count of [5, 8]) {
      const t = table(count, seed, false, undefined, false);
      t.command("start");
      expect(t.tick(deadline - 1)).toEqual([]);
      expect(t.lobby.game!.state().phase).toBe("Opening");
      expect(t.tick(deadline).filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
      expect(t.lobby.game!.state().phase).toBe("Day");
    }
  }
});

test("opening accepts a choice just before expiry but rejects it at the deadline", () => {
  for (const offset of [-1, 0]) {
    const t = table(8, 1n, false, undefined, false);
    t.command("start");
    const game = t.lobby.game!;
    const seer = game.state().pendingActors[0]!;
    const before = t.command("status");
    const deadline = 60_000 + new Rng(1n).below(60_001);
    expect(deadline).toBeGreaterThanOrEqual(60_000);
    expect(deadline).toBeLessThanOrEqual(120_000);
    expect(t.tick(deadline - 1)).toEqual([]);
    t.setNow(deadline + offset);
    const output = t.choose(seer, seer);
    if (offset < 0) {
      expect(output).toHaveLength(1);
      expect(output[0]?.destination).toBe("dm");
      expect(t.command("status")).toEqual(before);
      expect(game.state().inspections).toHaveLength(1);
      expect(t.tick(deadline).filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
    } else {
      expect(output.some((m) => m.text.includes("expired"))).toBe(true);
      expect(output.filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
      expect(game.state().inspections).toEqual([]);
    }
    expect(game.state().phase).toBe("Day");
    expect(t.tick(deadline + 1)).toEqual([]);
  }
});

test("invalid channels and duplicate events do not expire an opening", () => {
  const t = table(8, 1n, false, undefined, false);
  const input: SlackInput = { id: "start", kind: "mention", channel: "CGAME", user: "U0", text: "start" };
  t.bot.handle(input);
  t.setNow(120_000);
  expect(t.bot.handle(input)).toEqual([]);
  expect(t.command("status", "U0", "COTHER")).toEqual([]);
  expect(t.lobby.game!.state().phase).toBe("Opening");
  expect(t.tick(120_000).filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
});

test("cancelled openings clear their deadline and restarts invalidate old choices", () => {
  const t = table(8, 1n, false, undefined, false);
  t.command("start");
  const seer = t.lobby.game!.state().pendingActors[0]!;
  const value = t.value(`U${seer}`, seer)!;
  t.command("end");
  expect(t.tick(120_000)).toEqual([]);
  for (let seat = 0; seat < 8; seat++) t.command("join", `U${seat}`);
  t.command("start");
  expect(t.receive({ kind: "choice", channel: "DTEST", user: `U${seer}`, value })[0]?.text).toContain(
    "expired",
  );
  expect(t.tick(179_999)).toEqual([]);
  expect(t.lobby.game!.state().phase).toBe("Opening");
  expect(t.tick(240_000).filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
});

test("timer delivery failures retry the outbox without replaying the transition", async () => {
  const t = table(8, 1n, false, undefined, false);
  const sent: SlackMessage[] = [];
  let failing = true;
  let failures = 0;
  const delivery = new SlackDelivery(
    t.bot,
    async (message) => {
      if (failing) throw new Error("Unavailable");
      sent.push(message);
    },
    () => {
      failures++;
    },
  );
  await delivery.receive({ id: "start", kind: "mention", channel: "CGAME", user: "U0", text: "start" });
  t.setNow(120_000);
  await Promise.all([delivery.retry(), delivery.retry()]);
  expect(t.lobby.game!.state().phase).toBe("Day");
  expect(t.lobby.game!.state().inspections).toEqual([]);
  expect(failures).toBe(3);
  failing = false;
  await Promise.all([delivery.retry(), delivery.retry()]);
  expect(sent.filter((m) => m.destination === "channel" && m.text.startsWith("Opening before"))).toHaveLength(
    1,
  );
  expect(sent.filter((m) => m.text.startsWith("Day 1."))).toHaveLength(1);
  expect(sent[0]?.text).toContain("game has started");
  expect(sent.at(-1)?.text).toStartWith("Day 1.");
});

test("Hunter pauses play, recovers a private prompt, and fires exactly once", () => {
  const t = table(5, 42n);
  t.command("start");
  const game = t.lobby.game!;
  const hunter = game.state().players.find((p) => p.role === "Hunter")!.id;
  const wolf = game.state().players.find((p) => p.role === "Werewolf")!.id;
  const output = eliminate(t, hunter);
  expect(game.state().phase).toBe("Hunter");
  expect(game.state().winner).toBeUndefined();
  expect(output.some((m) => m.destination === "channel" && m.text.includes("final shot"))).toBe(true);
  const prompt = t.dm(`U${hunter}`).find((m) => m.choices)!;
  expect(prompt.destination).toBe("dm");
  expect(prompt.choices).toHaveLength(4);
  const value = t.value(`U${hunter}`, wolf)!;
  const before = game.state();
  expect(t.vote(wolf, wolf)[0]?.text).toContain("requires Day");
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value })[0]?.text).toContain(
    "belongs",
  );
  expect(game.state()).toEqual(before);
  const shot = t.choose(hunter, wolf);
  expect(shot.some((m) => m.destination === "channel" && m.text.includes("Hunter's final shot"))).toBe(true);
  expect(game.state().winner).toBe("Villagers");
  expect(t.lobby.game).toBeNull();
  expect(t.receive({ kind: "choice", user: `U${hunter}`, channel: "DTEST", value })[0]?.text).toContain(
    "not in an active game",
  );
});

test("channel boundary, host transfer, lobby minimum, and host-only start", () => {
  const t = table(4);
  expect(t.command("join", "OUTSIDER", "COTHER")).toEqual([]);
  expect(t.lobby.size).toBe(4);
  expect(t.command("start")[0]?.text).toContain("at least 5");
  expect(t.command("start", "U1")[0]?.text).toContain("Only the host");
  t.command("leave");
  expect(t.lobby.host?.user).toBe("U1");
  t.command("join", "U4");
  t.command("join", "U5");
  t.command("start", "U1");
  expect(t.lobby.game).not.toBeNull();
  expect(t.command("join", "U6")[0]?.destination).toBe("ephemeral");
  expect(t.command("leave", "U2")[0]?.text).toContain("in progress");
});

test("only the host can end a game in the game channel", () => {
  const t = table();
  expect(t.command("end")[0]?.text).toContain("no game running");
  t.command("start");
  const game = t.lobby.game;
  for (const user of ["U1", "OUTSIDER"]) {
    expect(t.command("end", user)[0]).toMatchObject({
      destination: "ephemeral",
      text: "Only the host can end the game.",
    });
  }
  expect(t.command("end", "U0", "COTHER")).toEqual([]);
  t.dm("U0", "end");
  expect(t.lobby.game).toBe(game);
  expect(t.command("end")[0]).toMatchObject({ destination: "channel" });
  expect(t.lobby.game).toBeNull();
  expect(t.lobby.isEmpty).toBe(true);
  expect(t.lobby.host).toBeNull();
  expect(t.vote(1, 2)[0]?.text).toContain("not in an active game");
  t.command("join", "NEW_HOST");
  expect(t.lobby.host?.user).toBe("NEW_HOST");
});

test("ending at night expires old buttons even after a restart", () => {
  const t = table();
  t.command("start");
  reachNight(t);
  const actor = t.lobby.game!.state().pendingActors[0]!;
  const user = `U${actor}`;
  const value = t.messages.findLast((m) => m.user === user && m.choices)!.choices![0]!.value;
  t.command("end");
  expect(t.receive({ kind: "choice", user, channel: `D${user}`, value })[0]?.text).toContain(
    "not in an active game",
  );
  for (let seat = 0; seat < 8; seat++) t.command("join", `U${seat}`);
  t.command("start");
  reachNight(t);
  expect(t.receive({ kind: "choice", user, channel: `D${user}`, value })[0]?.text).toContain("expired");
});

test("ending a dev game clears bots for a fresh solo game", () => {
  const t = table(1, 42n, true);
  t.command("start");
  t.command("end");
  expect(t.lobby.isEmpty).toBe(true);
  t.command("join");
  const output = t.command("start");
  expect(t.lobby.size).toBe(5);
  expect(output.filter((m) => m.destination === "dm").every((m) => m.user === "U0")).toBe(true);
});

test("roles, pack, prompts, and night progress stay private", () => {
  const t = table();
  const output = t.command("start");
  const state = t.lobby.game!.state();
  const wolves = state.players.filter((p) => p.role === "Werewolf");
  expect(state.phase).toBe("Day");
  expect(state.round).toBe(1);
  expect(state.players.every((p) => p.alive)).toBe(true);
  expect(state.majorityRequired).toBe(5);
  expect(state.votes).toEqual([]);
  expect(
    output.filter((m) => m.choices).every((m) => m.destination === "dm" && m.text.startsWith("Opening")),
  ).toBe(true);
  expect(output.some((m) => m.destination === "channel" && m.text.startsWith("Day 1. Discuss"))).toBe(true);
  expect(output.some((m) => m.text.startsWith("Night"))).toBe(false);
  expect(t.dm("U0").some((m) => m.choices)).toBe(false);
  for (const player of state.players) {
    const role = output.find((m) => m.user === `U${player.id}` && m.text.includes("You are Player"))!;
    expect(role.destination).toBe("dm");
    expect(role.text).toContain(player.role);
    expect(role.text.includes("Your pack:")).toBe(player.role === "Werewolf");
  }
  expect(
    output.find((m) => m.destination === "channel" && m.text.startsWith("The game has started"))?.text,
  ).toBe("The game has started with 8 players. Teams: 2 Werewolves and 6 Villagers. Roles are in your DMs.");
  const publicText = output
    .filter((m) => m.destination === "channel" && !m.text.startsWith("The game has started"))
    .map((m) => m.text)
    .join("\n");
  expect(publicText).not.toMatch(/pack|Werewolf|Villager/);
  reachNight(t);
  expect(t.messages.filter((m) => m.choices && m.text.startsWith("Night 1:")).length).toBe(wolves.length + 2);
  const target = state.players.find((p) => p.role === "Villager")!.id;
  expect(t.choose(wolves[0]!.id, target).every((m) => m.destination === "dm")).toBe(true);
  expect(t.command("status")[0]?.text).not.toMatch(/pending|pack|Werewolf|Villager/);
});

for (const count of [5, 8]) {
  test(`the last wolf's night prompt excludes itself with ${count} starting players`, () => {
    const t = table(count);
    t.command("start");
    const wolves = t.lobby.game!.state().players.filter((p) => p.role === "Werewolf");
    const wolf = wolves[0]!.id;
    if (wolves.length === 1) reachNight(t);
    else {
      eliminate(t, wolves[1]!.id);
    }
    const before = t.lobby.game!.state();
    expect(before.phase).toBe("Night");
    const user = `U${wolf}`;
    const prompt = t.dm(user).find((m) => m.choices)!;
    expect(prompt.choices!.map((c) => c.label)).toEqual(
      before.players.filter((p) => p.alive && p.id !== wolf).map((p) => `Player ${p.id + 1}`),
    );
    const forged = prompt.choices![0]!.value.replace(/:\d+$/, `:${wolf}`);
    const output = t.receive({ kind: "choice", user, channel: `D${user}`, value: forged });
    expect(output[0]?.text).toContain("cannot target themselves at night");
    expect(t.lobby.game!.state()).toEqual(before);
    morning(t);
    expect(t.lobby.game!.state().phase).toBe("Day");
  });
}

for (const order of [
  ["Werewolf", "Doctor", "Seer"],
  ["Werewolf", "Seer", "Doctor"],
  ["Doctor", "Werewolf", "Seer"],
  ["Doctor", "Seer", "Werewolf"],
  ["Seer", "Werewolf", "Doctor"],
  ["Seer", "Doctor", "Werewolf"],
]) {
  test(`night with a dead wolf resolves in order ${order.join(", ")} and status explains each player's action`, () => {
    const t = table();
    t.command("start");
    const game = t.lobby.game!;
    const deadWolf = game.state().players.find((p) => p.role === "Werewolf")!.id;
    eliminate(t, deadWolf);
    const state = game.state();
    expect(state.phase).toBe("Night");
    expect(state.pendingActors).toHaveLength(3);
    expect(state.pendingActors).not.toContain(deadWolf);
    const target = state.players.find((p) => p.role === "Villager")!.id;
    const publicStatus = t.command("status");
    expect(publicStatus[0]?.text).toContain("DM `status`");
    for (const seat of [deadWolf, target]) {
      const status = t.dm(`U${seat}`);
      expect(status.some((m) => m.text === "You have no action to take on Night 1.")).toBe(true);
      expect(status.some((m) => m.choices)).toBe(false);
    }
    for (const [index, role] of order.entries()) {
      const actor = state.players.find((p) => p.alive && p.role === role)!.id;
      const before = game.state();
      const status = t.dm(`U${actor}`);
      expect(status.every((m) => m.destination === "dm" && m.user === `U${actor}`)).toBe(true);
      expect(status.some((m) => m.text.includes("Your Night 1 action is still needed"))).toBe(true);
      expect(status.some((m) => m.choices)).toBe(true);
      expect(game.state()).toEqual(before);
      const result = t.choose(actor, target);
      if (index < 2) {
        expect(game.state().phase).toBe("Night");
        expect(game.state().pendingActors).not.toContain(actor);
        expect(result.every((m) => m.destination === "dm" && m.user === `U${actor}`)).toBe(true);
        const recorded = t.dm(`U${actor}`);
        expect(recorded.some((m) => m.text.includes("Your Night 1 action is recorded"))).toBe(true);
        expect(recorded.some((m) => m.choices)).toBe(false);
        expect(t.command("status")).toEqual(publicStatus);
      }
    }
    expect(game.state().phase).toBe("Day");
    expect(game.state().round).toBe(2);
    expect(game.isAlive(target)).toBe(true);
    eliminate(t, target);
    for (const actor of game.state().pendingActors) {
      const status = t.dm(`U${actor}`);
      expect(status.some((m) => m.text.includes("Your Night 2 action is still needed"))).toBe(true);
      expect(status.some((m) => m.text.includes("action is recorded"))).toBe(false);
    }
  });
}

test("night disagreement starts a private revote and invalidates old buttons", () => {
  const t = table();
  t.command("start");
  reachNight(t);
  const state = t.lobby.game!.state();
  const wolves = state.players.filter((p) => p.role === "Werewolf").map((p) => p.id);
  const [first, second] = wolves;
  for (const actor of state.pendingActors.filter((id) => !wolves.includes(id))) t.choose(actor, first!);
  const villagers = state.players.filter((p) => p.alive && p.role !== "Werewolf");
  const old = t.value(`U${first}`, villagers[0]!.id)!;
  t.choose(first!, villagers[0]!.id);
  const output = t.choose(second!, villagers[1]!.id);
  expect(output.every((m) => m.destination === "dm")).toBe(true);
  expect(output.some((m) => m.text.includes("pack disagreed"))).toBe(true);
  expect(t.lobby.game!.state().pendingActors).toEqual(wolves);
  expect(
    t.receive({ kind: "choice", user: `U${first}`, channel: `DU${first}`, value: old })[0]?.text,
  ).toContain("expired");
  morning(t);
  expect(t.lobby.game!.state().phase).toBe("Day");
});

test("night buttons reject outsiders, wrong owners, invalid targets and expired prompts", () => {
  const t = table();
  t.command("start");
  reachNight(t);
  const state = t.lobby.game!.state();
  const wolf = state.players.find((p) => p.alive && p.role === "Werewolf")!.id;
  const target = state.players.find((p) => p.alive && p.role === "Villager")!.id;
  const value = t.value(`U${wolf}`, target)!;
  expect(t.receive({ kind: "choice", user: "UOUTSIDE", channel: "DOUTSIDE", value })[0]?.text).toContain(
    "not in an active game",
  );
  expect(t.receive({ kind: "choice", user: `U${target}`, channel: "DTEST", value })[0]?.text).toContain(
    "belongs to another",
  );
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "CGAME", value })).toEqual([]);
  expect(
    t.receive({
      kind: "choice",
      user: `U${wolf}`,
      channel: "DTEST",
      value: value.replace(/:\d+$/, ":999"),
    })[0]?.text,
  ).toContain("Unknown target");
  morning(t);
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value })[0]?.text).toContain(
    "expired",
  );
  expect(t.dm(`U${wolf}`).some((m) => m.choices)).toBe(false);
});

test("event retries cannot replay a command or cross into another game", () => {
  const t = table();
  const input: SlackInput = { id: "same", kind: "mention", user: "U0", channel: "CGAME", text: "start" };
  expect(t.bot.handle(input).length).toBeGreaterThan(0);
  const before = t.lobby.game!.state();
  expect(t.bot.handle(input)).toEqual([]);
  expect(t.lobby.game!.state()).toEqual(before);
});

test("day status groups votes into a descending leaderboard with stable ties", () => {
  const t = table();
  t.command("start");
  const initial = t.command("status")[0]!.text;
  expect(initial).toContain("Vote leaderboard (5 needed):\nNo votes yet.");
  expect(initial).toContain("Not voted: <@U0>, <@U1>, <@U2>, <@U3>, <@U4>, <@U5>, <@U6>, <@U7>.");
  expect(initial).not.toContain("Living players:\n");
  expect(initial.endsWith("Living players: 8.")).toBe(true);
  t.vote(0, 4);
  t.vote(3, 6);
  t.vote(1, 6);
  t.vote(2, 5);
  const leaderboard =
    "Vote leaderboard (5 needed):\n• <@U6> — 2 votes\n  Voters: <@U1>, <@U3>\n• <@U4> — 1 vote\n  Voters: <@U0>\n• <@U5> — 1 vote\n  Voters: <@U2>\nNot voted: <@U4>, <@U5>, <@U6>, <@U7>.";
  expect(t.command("status")[0]?.text).toContain(leaderboard);
  expect(t.dm("U0").some((m) => m.text.includes(leaderboard))).toBe(true);
  t.vote(0, 6);
  t.vote(0, 6);
  const status = t.command("status")[0]!.text;
  expect(status).toContain("• <@U6> — 3 votes\n  Voters: <@U0>, <@U1>, <@U3>");
  expect(status).not.toContain("• <@U4>");
  expect(status).not.toContain("→");
  expect(status).toContain("Not voted: <@U4>, <@U5>, <@U6>, <@U7>.");
  expect(status).not.toContain("Living players:\n");
  expect(status.endsWith("Living players: 8.")).toBe(true);
  reachNight(t);
  const nightStatus = t.command("status")[0]!.text;
  expect(nightStatus).not.toContain("Vote leaderboard");
  expect(nightStatus).toContain("Living players:\n");
  morning(t);
  const nextDay = t.command("status")[0]!.text;
  const players = t.lobby.game!.state().players;
  const living = players.filter((player) => player.alive);
  expect(nextDay).toContain("No votes yet.");
  expect(nextDay).toContain(`Not voted: ${living.map((player) => `<@U${player.id}>`).join(", ")}.`);
  expect(nextDay.endsWith(`Living players: ${living.length}.`)).toBe(true);
  for (const player of players.filter((player) => !player.alive)) {
    expect(nextDay).not.toContain(`<@U${player.id}>`);
  }
});

test("public votes resolve immediately at a strict living majority on every day", () => {
  for (const count of [5, 7, 8]) {
    const t = table(count);
    expect(t.command("vote <@U1>")[0]?.text).toContain("not in an active game");
    t.command("start");
    const target = t.lobby.game!.state().players.find((p) => p.role === "Villager")!.id;
    const required = Math.floor(count / 2) + 1;
    for (let voter = 0; voter < required; voter++) {
      const output = t.command(` VoTe <@U${target}> `, `U${voter}`);
      expect(output[0]).toEqual({
        destination: "channel",
        text: `<@U${voter}> voted for <@U${target}> (${voter + 1}/${required} votes needed).`,
      });
      if (voter + 1 < required) {
        expect(t.lobby.game!.state().phase).toBe("Day");
        expect(output.some((m) => m.choices)).toBe(false);
      } else {
        expect(t.lobby.game!.state().phase).toBe("Night");
        expect(output.some((m) => m.text.includes("eliminated by the village"))).toBe(true);
        expect(output.some((m) => m.text.startsWith("Night 1."))).toBe(true);
      }
    }
    expect(t.lobby.game!.state().votes).toEqual([]);
    expect(t.vote(0, 1)[0]?.text).toContain("requires Day");
    morning(t);
    const game = t.lobby.game!;
    const state = game.state();
    expect(state.phase).toBe("Day");
    expect(state.round).toBe(2);
    expect(state.majorityRequired).toBe(Math.floor((count - 2) / 2) + 1);
    expect(state.votes).toEqual([]);
    const wolf = state.players.find((p) => p.alive && p.role === "Werewolf")!.id;
    eliminate(t, wolf);
    expect(game.isAlive(wolf)).toBe(false);
  }
});

test("split votes stay in day, votes can change, and retries never count twice", () => {
  const t = table(6);
  t.command("start");
  for (let seat = 0; seat < 6; seat++) t.vote(seat, seat);
  expect(t.lobby.game!.state().phase).toBe("Day");
  expect(t.lobby.game!.state().pendingActors).toEqual([]);
  const input: SlackInput = {
    id: "vote-retry",
    kind: "mention",
    channel: "CGAME",
    user: "U1",
    text: "vote <@U0>",
  };
  t.bot.handle(input);
  const before = t.lobby.game!.state();
  expect(t.bot.handle(input)).toEqual([]);
  t.vote(1, 0);
  expect(t.lobby.game!.state()).toEqual(before);
  t.vote(2, 0);
  expect(t.lobby.game!.state().phase).toBe("Day");
  expect(t.command("status")[0]?.text).toContain("4 needed");
  expect(t.command("status")[0]?.text).toContain("• <@U0> — 3 votes\n  Voters: <@U0>, <@U1>, <@U2>");
  const game = t.lobby.game!;
  t.vote(3, 0);
  expect(game.isAlive(0)).toBe(false);
  expect(game.state().phase).not.toBe("Day");
});

test("day voting requires one valid channel mention from a living player", () => {
  const t = table();
  t.command("start");
  const before = t.lobby.game!.state();
  for (const command of [
    "vote",
    "vote U1",
    "vote <@U1> <@U2>",
    "vote 2",
    "vote <@U1> extra",
    "vote <@UNKNOWN>",
  ]) {
    expect(t.command(command)[0]?.destination).toBe("ephemeral");
    expect(t.lobby.game!.state()).toEqual(before);
  }
  expect(t.command("vote <@U1>", "OUTSIDER")[0]?.text).toContain("not in an active game");
  expect(t.command("vote <@U1>", "U0", "COTHER")).toEqual([]);
  for (const command of ["vote <@U1>", "vote", "ready", "ready to vote"]) {
    expect(t.dm("U0", command)[0]?.text).toContain("Vote in <#CGAME>");
    expect(t.lobby.game!.state()).toEqual(before);
  }
  expect(t.command("ready")[0]?.text).toContain("vote @player");
  expect(t.dm("U0").some((m) => m.choices)).toBe(false);
  const forged = `${crypto.randomUUID()}:U0:1`;
  expect(t.receive({ kind: "choice", user: "U0", channel: "DU0", value: forged })[0]?.text).toContain(
    "expired",
  );
  expect(t.lobby.game!.state()).toEqual(before);
  expect(t.command("VOTE <@U1|Name>")[0]?.text).toContain("<@U0> voted for <@U1>");
  reachNight(t);
  morning(t);
  const state = t.lobby.game!.state();
  const dead = state.players.find((p) => !p.alive)!.id;
  const living = state.players.find((p) => p.alive)!.id;
  expect(t.vote(dead, living)[0]?.text).toContain("not alive");
  expect(t.vote(living, dead)[0]?.text).toContain("not alive");
  expect(t.lobby.game!.state()).toEqual(state);
});

test("real engine games finish for every lobby size and can restart", () => {
  for (let count = 5; count <= 12; count++) {
    for (let seed = 0n; seed < 10n; seed++) {
      const t = table(count, seed);
      const start = t.command("start");
      const firstState = t.lobby.game!.state();
      const wolves = firstState.players.filter((p) => p.role === "Werewolf").length;
      const villagers = firstState.aliveVillagers;
      expect(
        start.find((m) => m.destination === "channel" && m.text.startsWith("The game has started"))?.text,
      ).toBe(
        `The game has started with ${count} players. Teams: ${wolves} ${wolves === 1 ? "Werewolf" : "Werewolves"} and ${villagers} Villagers. Roles are in your DMs.`,
      );
      const wolf = firstState.pendingActors[0]!;
      let old: string | undefined;
      let turns = 0;
      while (t.lobby.game) {
        if (++turns > 24) throw new Error("Game did not finish");
        const state = t.lobby.game.state();
        if (state.phase === "Night") morning(t);
        else if (state.phase === "Hunter") {
          t.choose(state.pendingActors[0]!, state.players.find((p) => p.alive)!.id);
        } else {
          expect(state.votes).toEqual([]);
          old ??= `${crypto.randomUUID()}:U${wolf}:0`;
          const target = state.players.find((p) => p.alive && p.role === "Werewolf")!.id;
          eliminate(t, target);
        }
      }
      expect(old).toBeDefined();
      expect(t.messages.some((m) => m.destination === "channel" && m.text.includes("win!"))).toBe(true);
      expect(t.lobby.state).toBe("Waiting");
      expect(t.lobby.size).toBe(0);
      expect(t.lobby.host).toBeNull();
      expect(t.command("status")[0]?.text).toContain("Lobby: 0/12");
      expect(
        t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value: old })[0]?.text,
      ).toContain("not in an active game");
      for (let seat = 0; seat < count; seat++) t.command("join", `U${seat}`);
      t.command("start");
      expect(t.lobby.game!.state().round).toBe(1);
      expect(
        t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value: old })[0]?.text,
      ).toContain("expired");
    }
  }
});

test("delivery retries failed messages in order without replaying mutations", async () => {
  const t = table(0);
  const delivered: SlackMessage[] = [];
  let failing = true;
  let failures = 0;
  const delivery = new SlackDelivery(
    t.bot,
    async (message) => {
      if (failing) throw new Error("Slack unavailable");
      delivered.push(message);
    },
    () => {
      failures++;
    },
  );
  const join: SlackInput = { id: "join", kind: "mention", channel: "CGAME", user: "U0", text: "join" };
  await delivery.receive(join);
  expect(t.lobby.size).toBe(1);
  expect(failures).toBe(1);
  failing = false;
  await Promise.all([delivery.receive(join), delivery.receive({ ...join, id: "join2", user: "U1" })]);
  await delivery.retry();
  expect(t.lobby.size).toBe(2);
  expect(delivered.length).toBe(2);
  expect(delivered[0]?.text).toContain("<@U0> joined");
  expect(delivered[1]?.text).toContain("<@U1> joined");
});

test("werewolf victory opens a fresh lobby with a new host", () => {
  const t = table(5);
  t.command("start");
  reachNight(t);
  const state = t.lobby.game!.state();
  morning(t);
  const target = t.lobby.game!.state().players.find((p) => p.alive && p.role !== "Werewolf")!.id;
  eliminate(t, target);
  expect(t.lobby.game).toBeNull();
  const announcement = t.messages.find(
    (m) => m.destination === "channel" && m.text.startsWith("Werewolves win!"),
  )!;
  expect(announcement.text).toContain("A new lobby is open!");
  expect(announcement.text).toContain("@werewolf join");
  for (const player of state.players) expect(announcement.text).toContain(`<@U${player.id}>: ${player.role}`);
  expect(t.lobby.isEmpty).toBe(true);
  expect(t.command("start")[0]?.text).toContain("Only the host");
  t.command("join", "NEW_HOST");
  expect(t.lobby.host?.user).toBe("NEW_HOST");
  for (let seat = 0; seat < 4; seat++) t.command("join", `U${seat}`);
  expect(t.command("start")[0]?.text).toContain("Only the host");
  t.command("start", "NEW_HOST");
  expect(t.lobby.game!.state().phase).toBe("Day");
  expect(t.lobby.game!.state().round).toBe(1);
});

for (const winner of ["Villagers", "Werewolves"] as const) {
  test(`completed ${winner} wins persist the original roster, including eliminated players`, () => {
    const stats = openStats(":memory:");
    try {
      const t = table(5, 1n, false, (result) => stats.record("TWORKSPACE", result));
      t.command("start");
      const players = t.lobby.game!.state().players;
      t.bot.saveResults();
      expect(stats.db.select().from(games).all()).toEqual([]);
      if (winner === "Werewolves") reachNight(t);
      else eliminate(t, players.find((p) => p.role === "Werewolf")!.id);
      if (winner === "Werewolves") {
        morning(t);
        eliminate(t, t.lobby.game!.state().players.find((p) => p.alive && p.role !== "Werewolf")!.id);
      }
      expect(t.lobby.isEmpty).toBe(true);
      t.bot.saveResults();
      t.bot.saveResults();
      const saved = stats.db.select().from(games).all();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ workspaceId: "TWORKSPACE", channelId: "CGAME", winner, dev: false });
      expect(saved[0]!.finishedAt.getTime()).toBeGreaterThanOrEqual(saved[0]!.startedAt.getTime());
      expect(stats.db.select().from(gamePlayers).orderBy(gamePlayers.seat).all()).toEqual(
        players.map((p) => ({
          gameId: saved[0]!.id,
          seat: p.id,
          userId: `U${p.id}`,
          role: p.role,
          isBot: false,
        })),
      );
      for (let seat = 0; seat < 5; seat++) t.command("join", `U${seat}`);
      t.command("start");
      eliminate(t, t.lobby.game!.state().players.find((p) => p.role === "Werewolf")!.id);
      t.bot.saveResults();
      expect(stats.db.select().from(games).all()).toHaveLength(2);
    } finally {
      stats.close();
    }
  });
}

test("cancelled games produce no stats", () => {
  const results: FinishedGame[] = [];
  const t = table(5, 42n, false, (result) => results.push(result));
  t.command("start");
  t.command("end");
  t.bot.saveResults();
  expect(results).toEqual([]);
});

test("failed stats writes retry before win messages without replaying the final vote", async () => {
  const results: FinishedGame[] = [];
  let failing = true;
  let failures = 0;
  const t = table(5, 42n, false, (result) => {
    if (failing) throw new Error("Database unavailable");
    results.push(result);
  });
  t.command("start");
  const wolf = t.lobby.game!.state().players.find((p) => p.role === "Werewolf")!.id;
  t.vote(0, wolf);
  t.vote(1, wolf);
  const sent: SlackMessage[] = [];
  const delivery = new SlackDelivery(
    t.bot,
    async (message) => {
      sent.push(message);
    },
    () => {
      failures++;
    },
  );
  const input: SlackInput = {
    id: "final-vote",
    kind: "mention",
    user: "U2",
    channel: "CGAME",
    text: `vote <@U${wolf}>`,
  };
  await delivery.receive(input);
  expect(t.lobby.isEmpty).toBe(true);
  expect(failures).toBe(1);
  expect(sent).toEqual([]);
  failing = false;
  await delivery.retry();
  await delivery.receive(input);
  expect(results).toHaveLength(1);
  expect(sent.filter((m) => m.text.startsWith("Villagers win!"))).toHaveLength(1);
});

test("configuration requires tokens and a public channel ID without exposing secrets", () => {
  expect(() => slackConfig({})).toThrow("SLACK_BOT_TOKEN");
  const env = { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_APP_TOKEN: "xapp-secret", SLACK_CHANNEL_ID: "CGAME" };
  expect(slackConfig(env).channel).toBe("CGAME");
  expect(() => slackConfig({ ...env, SLACK_CHANNEL_ID: "#werewolf" })).toThrow("SLACK_CHANNEL_ID");
});

test("Slack CLI dev mode is opt-in and rejects unknown flags", () => {
  expect(slackArgs([])).toEqual({ dev: false, help: false });
  expect(slackArgs(["--", "--dev"])).toEqual({ dev: true, help: false });
  expect(slackArgs(["--help"]).help).toBe(true);
  expect(() => slackArgs(["--development"])).toThrow("Unknown argument");
});

test("startup accepts only werewolf channels with active bot membership", () => {
  for (const name of ["werewolf", "werewolf-test"]) {
    expect(slackChannel({ name, is_member: true, is_archived: false })).toBe(name);
    expect(() => slackChannel({ name, is_member: false })).toThrow("invite the bot");
    expect(() => slackChannel({ name, is_member: true, is_archived: true })).toThrow("not archived");
  }
  for (const name of ["general", "werewolf-testing", "werewolf-test-extra", ""]) {
    expect(() => slackChannel({ name, is_member: true })).toThrow("#werewolf or #werewolf-test");
  }
  expect(() => slackChannel()).toThrow("SLACK_CHANNEL_ID");
});

test("dev mode requires a human host and advertises solo play", () => {
  const empty = table(0, 42n, true);
  expect(empty.command("start")[0]?.text).toContain("Only the host");
  expect(empty.lobby.size).toBe(0);
  const t = table(1, 42n, true);
  expect(t.command("help")[0]?.text).toContain("Dev mode");
  expect(t.command("status")[0]?.text).toContain("minimum 1 human");
  expect(t.command("start", "OUTSIDER")[0]?.text).toContain("Only the host");
  expect(t.lobby.size).toBe(1);
});

test("dev games fill with bots, wait for humans, finish after elimination, and clean up for replay", () => {
  const roles = new Set<string>();
  let soloVotes = 0;
  let eliminatedHumans = 0;
  for (const humans of [1, 2, 4, 5]) {
    for (let seed = 0n; seed < 30n; seed++) {
      const results: FinishedGame[] = [];
      const t = table(humans, seed, true, (result) => results.push(result));
      const start = t.command("start");
      expect(start[0]?.text).toContain("started with 5 players");
      expect(t.lobby.game!.state().phase).toBe("Day");
      expect(t.lobby.game!.state().players.every((p) => p.alive)).toBe(true);
      expect(start.filter((m) => m.choices).every((m) => m.text.startsWith("Opening"))).toBe(true);
      expect(start.filter((m) => m.text.includes("You are Player")).length).toBe(humans);
      roles.add(
        start
          .find((m) => m.user === "U0" && m.text.includes("You are Player"))!
          .text.split("a ")[1]!
          .split(".")[0]!,
      );
      let turns = 0;
      while (t.lobby.game) {
        if (++turns > 100) throw new Error("Dev game did not finish");
        const game = t.lobby.game;
        const state = game.state();
        expect(state.players.length).toBe(5);
        const humanActors = (
          state.phase === "Day" ? state.players.filter((p) => p.alive).map((p) => p.id) : state.pendingActors
        ).filter((seat) => seat < humans);
        expect(humanActors.length).toBeGreaterThan(0);
        if (state.phase === "Hunter") {
          t.choose(state.pendingActors[0]!, state.players.find((p) => p.alive)!.id);
        } else if (state.phase === "Night") {
          const target = state.players.find((p) => p.alive && p.role !== "Werewolf")!.id;
          for (const seat of humanActors) t.choose(seat, target);
        } else {
          expect(t.dm(`U${humanActors[0]}`).some((m) => m.choices)).toBe(false);
          expect(t.command("vote <@U0>", "OUTSIDER")[0]?.text).toContain("not in an active game");
          const target = state.players.find((p) => p.alive && p.role === "Werewolf")!.id;
          for (const seat of humanActors) {
            if (game.state().phase !== "Day" || game.state().round !== state.round) break;
            t.vote(seat, target);
            if (humans === 1) soloVotes++;
          }
        }
      }
      expect(t.messages.some((m) => m.text.includes("win!"))).toBe(true);
      eliminatedHumans += t.messages.filter(
        (m) => m.destination === "dm" && m.text.startsWith("You were eliminated."),
      ).length;
      expect(
        t.messages.every(
          (m) => m.destination === "channel" || m.user === "OUTSIDER" || /^U\d+$/.test(m.user!),
        ),
      ).toBe(true);
      expect(t.messages.every((m) => !m.text.includes("<@bot-"))).toBe(true);
      t.bot.saveResults();
      expect(results).toHaveLength(1);
      expect(results[0]!.dev).toBe(true);
      expect(results[0]!.players).toHaveLength(5);
      expect(results[0]!.players.filter((p) => p.isBot)).toHaveLength(5 - humans);
      expect(results[0]!.players.filter((p) => !p.isBot).map((p) => p.userId)).toEqual(
        Array.from({ length: humans }, (_, seat) => `U${seat}`),
      );
      expect(t.lobby.members).toEqual([]);
      expect(t.lobby.host).toBeNull();
      for (let seat = 0; seat < humans; seat++) t.command("join", `U${seat}`);
      expect(t.command("start")[0]?.text).toContain("started with 5 players");
    }
  }
  expect(roles).toEqual(new Set(["Werewolf", "Villager", "Doctor", "Seer", "Hunter"]));
  expect(soloVotes).toBeGreaterThan(0);
  expect(eliminatedHumans).toBeGreaterThan(0);
});

test("scope errors explain bot reinstall or app token repair without dumping API data", () => {
  const data = {
    error: "missing_scope",
    needed: "channels:read,groups:read,mpim:read,im:read",
    provided: "channels:history,chat:write,commands",
    token: "xoxb-secret",
  };
  const message = slackErrorMessage({ data });
  expect(message).toContain("Token currently grants: channels:history, chat:write, commands");
  expect(message).toContain("Reinstall the app");
  expect(message).toContain("app_mentions:read");
  expect(message).not.toContain("xoxb-secret");
  const socket = slackErrorMessage({
    original: { data: { error: "missing_scope", needed: "connections:write" } },
  });
  expect(socket).toContain("SLACK_APP_TOKEN");
  expect(socket).not.toContain("Bot Token Scopes");
  expect(slackErrorMessage(new Error("invalid_auth"))).toBe("invalid_auth");
});

test("Slack buttons cover all targets with unique action IDs and readable seat labels", () => {
  const t = table(12);
  t.command("start");
  reachNight(t);
  const prompt = t.messages.findLast((m) => m.choices)!;
  const blocks = messageBlocks(prompt)!;
  const actions = blocks.slice(1) as Array<{ elements: Array<{ action_id: string; value: string }> }>;
  expect(actions.map((block) => block.elements.length)).toEqual([5, 5, 1]);
  expect(new Set(actions.flatMap((block) => block.elements.map((button) => button.action_id))).size).toBe(11);
  expect(prompt.text).toContain("Living players:");
});

test("doctor saves are public without revealing the doctor and seer results remain private", () => {
  const t = table(7);
  t.command("start");
  reachNight(t);
  const game = t.lobby.game!;
  const players = game.state().players;
  const doctor = players.find((p) => p.role === "Doctor")!.id;
  const seer = players.find((p) => p.role === "Seer")!.id;
  const wolf = players.find((p) => p.role === "Werewolf")!.id;
  const target = players.find((p) => p.alive && p.role === "Villager")!.id;
  const doctorPrompt = t.dm(`U${doctor}`).find((m) => m.choices)!;
  expect(doctorPrompt.text).toContain("protect, including yourself");
  expect(doctorPrompt.choices!.some((c) => c.label === `Player ${doctor + 1}`)).toBe(true);
  const inspection = t.choose(seer, wolf);
  expect(inspection.every((m) => m.destination === "dm" && m.user === `U${seer}`)).toBe(true);
  expect(inspection.some((m) => m.text === `Your inspection: <@U${wolf}> is a Werewolf.`)).toBe(true);
  expect(t.choose(seer, doctor)[0]?.text).toContain("already acted");
  t.choose(doctor, target);
  expect(t.choose(doctor, doctor)[0]?.text).toContain("already acted");
  const dawn = players.filter((p) => p.role === "Werewolf").flatMap((p) => t.choose(p.id, target));
  expect(dawn.find((m) => m.text.includes("Doctor saved"))).toEqual({
    destination: "channel",
    text: `The Werewolves attacked <@U${target}>, but the Doctor saved them! No one was eliminated.`,
  });
  expect(game.state().players.filter((p) => p.alive).length).toBe(6);
  expect(game.state().round).toBe(2);
  expect(t.dm(`U${seer}`).some((m) => m.text === `Night 1 inspection: <@U${wolf}> is a Werewolf.`)).toBe(
    true,
  );
  for (const player of players.filter((p) => p.id !== seer)) {
    expect(t.dm(`U${player.id}`).some((m) => /inspection:/.test(m.text))).toBe(false);
  }
  expect(t.command("status").some((m) => /inspection|protect|Werewolf|Doctor|Seer/.test(m.text))).toBe(false);
  reachNextNight();
  expect(t.choose(seer, doctor).some((m) => m.text === `Your inspection: <@U${doctor}> is innocent.`)).toBe(
    true,
  );

  function reachNextNight() {
    eliminate(t, target);
    expect(game.state().phase).toBe("Night");
    expect(game.state().round).toBe(2);
  }
});
