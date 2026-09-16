import { expect, test } from "bun:test";
import { Lobby } from "./lobby.js";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackInput, type SlackMessage } from "./slack/game.js";
import { messageBlocks, slackArgs, slackChannel, slackConfig, slackErrorMessage } from "./slackbot.js";

class SeededLobby extends Lobby {
  constructor(private seed: bigint) { super(); }
  override start(host: string) { return this.startWithSeed(host, this.seed); }
}

function table(count = 8, seed = 42n, dev = false) {
  const lobby = new SeededLobby(seed);
  const bot = new SlackGame("CGAME", lobby, { dev, seed });
  let sequence = 0;
  const messages: SlackMessage[] = [];
  const receive = (input: Omit<SlackInput, "id"> & { text?: string; value?: string }) => {
    const output = bot.handle({ ...input, id: `event-${sequence++}` } as SlackInput);
    messages.push(...output);
    return output;
  };
  const command = (text: string, user = "U0", channel = "CGAME") => receive({ kind: "mention", text, user, channel });
  const dm = (user: string, text = "status") => receive({ kind: "dm", text, user, channel: `D${user}` });
  const value = (user: string, target: number) => messages.findLast(m => m.user === user && m.choices)?.choices?.find(c => c.label === `Player ${target + 1}`)?.value;
  const choose = (seat: number, target: number) => {
    const user = `U${seat}`;
    const choice = value(user, target);
    if (!choice) throw new Error(`No prompt for ${user} -> ${target}`);
    return receive({ kind: "choice", user, channel: `D${user}`, value: choice });
  };
  for (let seat = 0; seat < count; seat++) command("join", `U${seat}`);
  return { bot, lobby, messages, receive, command, dm, choose, value };
}

function reachNight(t: ReturnType<typeof table>) {
  openVoting(t);
  for (const seat of t.lobby.game!.state().pendingActors) t.choose(seat, seat);
  expect(t.lobby.game!.state().phase).toBe("Night");
  expect(t.lobby.game!.state().round).toBe(1);
}

function morning(t: ReturnType<typeof table>) {
  const state = t.lobby.game!.state();
  const target = state.players.find(p => p.alive && p.role === "Villager")!.id;
  for (const wolf of state.pendingActors) t.choose(wolf, target);
  return target;
}

function openVoting(t: ReturnType<typeof table>): SlackMessage[] {
  let output: SlackMessage[] = [];
  for (const player of t.lobby.game!.state().players.filter(p => p.alive)) {
    if (t.lobby.game!.state().votingOpen) break;
    if (!t.lobby.game!.state().readyPlayers.includes(player.id)) output = t.command("vote", `U${player.id}`);
  }
  return output;
}

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

test("roles, pack, prompts, and night progress stay private", () => {
  const t = table();
  const output = t.command("start");
  const state = t.lobby.game!.state();
  const wolves = state.players.filter(p => p.role === "Werewolf");
  expect(state.phase).toBe("Day");
  expect(state.round).toBe(1);
  expect(state.players.every(p => p.alive)).toBe(true);
  expect(state.votingOpen).toBe(false);
  expect(state.readyPlayers).toEqual([]);
  expect(output.some(m => m.choices)).toBe(false);
  expect(output.some(m => m.destination === "channel" && m.text.startsWith("Day 1. Discuss"))).toBe(true);
  expect(output.some(m => m.text.startsWith("Night"))).toBe(false);
  expect(t.dm("U0").some(m => m.choices)).toBe(false);
  for (const player of state.players) {
    const role = output.find(m => m.user === `U${player.id}` && m.text.includes("You are Player"))!;
    expect(role.destination).toBe("dm");
    expect(role.text).toContain(player.role);
    expect(role.text.includes("Your pack:")).toBe(player.role === "Werewolf");
  }
  expect(output.find(m => m.destination === "channel" && m.text.startsWith("The game has started"))?.text)
    .toBe("The game has started with 8 players. Teams: 2 Werewolves and 6 Villagers. Roles are in your DMs.");
  const publicText = output.filter(m => m.destination === "channel" && !m.text.startsWith("The game has started")).map(m => m.text).join("\n");
  expect(publicText).not.toMatch(/pack|Werewolf|Villager/);
  reachNight(t);
  expect(t.messages.filter(m => m.choices && m.text.startsWith("Night 1:")).length).toBe(wolves.length);
  const target = state.players.find(p => p.role === "Villager")!.id;
  expect(t.choose(wolves[0]!.id, target).every(m => m.destination === "dm")).toBe(true);
  expect(t.command("status")[0]?.text).not.toMatch(/pending|pack|Werewolf|Villager/);
});

for (const count of [5, 8]) {
  test(`the last wolf's night prompt excludes itself with ${count} starting players`, () => {
    const t = table(count);
    t.command("start");
    const wolves = t.lobby.game!.state().players.filter(p => p.role === "Werewolf");
    const wolf = wolves[0]!.id;
    if (wolves.length === 1) reachNight(t);
    else {
      openVoting(t);
      for (const seat of t.lobby.game!.state().pendingActors) t.choose(seat, wolves[1]!.id);
    }
    const before = t.lobby.game!.state();
    expect(before.phase).toBe("Night");
    const user = `U${wolf}`;
    const prompt = t.dm(user).find(m => m.choices)!;
    expect(prompt.choices!.map(c => c.label)).toEqual(
      before.players.filter(p => p.alive && p.id !== wolf).map(p => `Player ${p.id + 1}`),
    );
    const forged = prompt.choices![0]!.value.replace(/:\d+$/, `:${wolf}`);
    const output = t.receive({ kind: "choice", user, channel: `D${user}`, value: forged });
    expect(output[0]?.text).toContain("cannot target themselves at night");
    expect(t.lobby.game!.state()).toEqual(before);
    morning(t);
    expect(t.lobby.game!.state().phase).toBe("Day");
  });
}

test("night disagreement starts a private revote and invalidates old buttons", () => {
  const t = table();
  t.command("start");
  reachNight(t);
  const state = t.lobby.game!.state();
  const [first, second] = state.pendingActors;
  const villagers = state.players.filter(p => p.role === "Villager");
  const old = t.value(`U${first}`, villagers[0]!.id)!;
  t.choose(first!, villagers[0]!.id);
  const output = t.choose(second!, villagers[1]!.id);
  expect(output.every(m => m.destination === "dm")).toBe(true);
  expect(output.some(m => m.text.includes("pack disagreed"))).toBe(true);
  expect(t.lobby.game!.state().pendingActors).toEqual(state.pendingActors);
  expect(t.receive({ kind: "choice", user: `U${first}`, channel: `DU${first}`, value: old })[0]?.text).toContain("expired");
  morning(t);
  expect(t.lobby.game!.state().phase).toBe("Day");
});

test("discussion precedes voting; outsiders, wrong owners, invalid targets and dead voters are rejected", () => {
  const t = table();
  t.command("start");
  reachNight(t);
  const state = t.lobby.game!.state();
  const wolf = state.pendingActors[0]!;
  const target = state.players.find(p => p.role === "Villager")!.id;
  const value = t.value(`U${wolf}`, target)!;
  expect(t.receive({ kind: "choice", user: "UOUTSIDE", channel: "DOUTSIDE", value })[0]?.text).toContain("not in an active game");
  expect(t.receive({ kind: "choice", user: `U${target}`, channel: "DTEST", value })[0]?.text).toContain("belongs to another");
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "CGAME", value })).toEqual([]);
  expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value: value.replace(/:\d+$/, ":999") })[0]?.text).toContain("Unknown target");
  const eliminated = morning(t);
  expect(t.dm(`U${wolf}`).some(m => m.choices)).toBe(false);
  expect(openVoting(t).filter(m => m.choices).length).toBe(7);
  expect(t.command("vote", `U${wolf}`)[0]?.text).toContain("already open");
  expect(t.dm(`U${eliminated}`).some(m => m.choices)).toBe(false);
  const living = t.lobby.game!.state().pendingActors;
  const currentValue = t.value(`U${living[0]}`, living[1]!)!;
  expect(t.receive({ kind: "choice", user: `U${eliminated}`, channel: "DTEST", value: currentValue.replace(`:U${living[0]}:`, `:U${eliminated}:`) })[0]?.text).toContain("not alive");
  expect(t.receive({ kind: "choice", user: `U${living[0]}`, channel: "DTEST", value: currentValue.replace(/:\d+$/, `:${eliminated}`) })[0]?.text).toContain("not alive");
  t.choose(living[0]!, living[1]!);
  expect(t.choose(living[0]!, living[1]!)[0]?.text).toContain("already");
});

test("event retries cannot replay a command or cross into another game", () => {
  const t = table();
  const input: SlackInput = { id: "same", kind: "mention", user: "U0", channel: "CGAME", text: "start" };
  expect(t.bot.handle(input).length).toBeGreaterThan(0);
  expect(t.bot.handle(input)).toEqual([]);
  expect(t.lobby.game!.state().round).toBe(1);
});

test("a strict living majority opens voting through mentions or DMs, without host control", () => {
  for (const count of [5, 6, 8]) {
    const t = table(count);
    expect(t.command("ready")[0]?.text).toContain("not in an active game");
    t.command("start");
    reachNight(t);
    expect(t.command("ready")[0]?.text).toContain("requires Day");
    const eliminated = morning(t);
    const game = t.lobby.game!;
    const living = game.state().players.filter(p => p.alive).map(p => p.id);
    const required = Math.floor(living.length / 2) + 1;
    const actors = living.filter(id => id !== 0).slice(0, required);
    expect(actors.length).toBe(required);
    expect(t.command("status")[0]?.text).toContain(`0/${required} ready`);
    expect(t.command("ready", "OUTSIDER")[0]?.text).toContain("not in an active game");
    expect(t.dm(`U${eliminated}`, "ready")[0]?.text).toContain("not alive");
    expect(t.command("ready", `U${actors[0]}`, "COTHER")).toEqual([]);
    for (let index = 0; index < actors.length; index++) {
      const user = `U${actors[index]}`;
      const input: SlackInput = { id: `ready-${index}`, kind: "mention", user, channel: "CGAME", text: "ready" };
      const output = index === 0 ? t.bot.handle(input)
        : index === 1 ? t.dm(user, " Ready To Vote ") : t.command("vote", user);
      if (index === 0) {
        expect(t.bot.handle(input)).toEqual([]);
        expect(t.dm(user, "ready")[0]?.text).toContain("already");
      }
      expect(game.state().readyPlayers.length).toBe(index + 1);
      expect(game.state().phase).toBe("Day");
      expect(game.state().round).toBe(2);
      expect(game.state().players.filter(p => p.alive).length).toBe(living.length);
      expect(game.state().votes).toEqual([]);
      if (index + 1 < required) {
        expect(game.state().votingOpen).toBe(false);
        expect(output.some(m => m.choices)).toBe(false);
        expect(t.dm(user).some(m => m.choices)).toBe(false);
      } else {
        expect(game.state().votingOpen).toBe(true);
        expect(output.filter(m => m.text.startsWith("Voting is open")).length).toBe(1);
        expect(output.filter(m => m.choices).map(m => m.user).sort()).toEqual(living.map(id => `U${id}`).sort());
      }
    }
    expect(t.command("status")[0]?.text).toContain("voting open");
    expect(t.command("ready to vote", `U${actors[0]}`)[0]?.text).toContain("already open");
  }
});

test("readiness resets after a tied vote and a new morning", () => {
  const t = table(8);
  t.command("start");
  openVoting(t);
  const living = t.lobby.game!.state().pendingActors;
  for (const player of living) t.choose(player, player);
  expect(t.lobby.game!.state().readyPlayers).toEqual([]);
  morning(t);
  expect(t.lobby.game!.state().votingOpen).toBe(false);
  expect(t.command("status")[0]?.text).toContain("0/4 ready");
  const player = t.lobby.game!.state().pendingActors[0]!;
  expect(t.command("ready to vote", `U${player}`).some(m => m.choices)).toBe(false);
  expect(t.lobby.game!.state().readyPlayers).toEqual([player]);
});

test("a tied day advances to the next night and old day buttons expire", () => {
  const t = table(5);
  t.command("start");
  openVoting(t);
  const living = t.lobby.game!.state().pendingActors;
  const old = t.value(`U${living[0]}`, living[0]!)!;
  for (const seat of living) t.choose(seat, seat);
  expect(t.lobby.game!.state().phase).toBe("Night");
  expect(t.lobby.game!.state().round).toBe(1);
  expect(t.messages.some(m => m.text.includes("vote was tied"))).toBe(true);
  expect(t.receive({ kind: "choice", user: `U${living[0]}`, channel: "DTEST", value: old })[0]?.text).toContain("expired");
});

test("real engine games finish for every lobby size and can restart", () => {
  for (let count = 5; count <= 12; count++) {
    for (let seed = 0n; seed < 10n; seed++) {
      const t = table(count, seed);
      const start = t.command("start");
      const firstState = t.lobby.game!.state();
      const wolves = firstState.players.filter(p => p.role === "Werewolf").length;
      const villagers = firstState.players.filter(p => p.role === "Villager").length;
      expect(start.find(m => m.destination === "channel" && m.text.startsWith("The game has started"))?.text)
        .toBe(`The game has started with ${count} players. Teams: ${wolves} ${wolves === 1 ? "Werewolf" : "Werewolves"} and ${villagers} Villagers. Roles are in your DMs.`);
      const wolf = firstState.pendingActors[0]!;
      let old: string | undefined;
      let turns = 0;
      while (t.lobby.game) {
        if (++turns > 24) throw new Error("Game did not finish");
        const state = t.lobby.game.state();
        if (state.phase === "Night") morning(t);
        else {
          expect(state.readyPlayers).toEqual([]);
          expect(state.votingOpen).toBe(false);
          openVoting(t);
          old ??= t.value(`U${wolf}`, 0)!;
          const target = state.players.find(p => p.alive && p.role === "Werewolf")!.id;
          for (const seat of state.pendingActors) t.choose(seat, target);
        }
      }
      expect(old).toBeDefined();
      expect(t.messages.some(m => m.destination === "channel" && m.text.includes("win!"))).toBe(true);
      expect(t.lobby.state).toBe("Waiting");
      expect(t.lobby.size).toBe(0);
      expect(t.lobby.host).toBeNull();
      expect(t.command("status")[0]?.text).toContain("Lobby: 0/12");
      expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value: old })[0]?.text).toContain("not in an active game");
      for (let seat = 0; seat < count; seat++) t.command("join", `U${seat}`);
      t.command("start");
      expect(t.lobby.game!.state().round).toBe(1);
      expect(t.receive({ kind: "choice", user: `U${wolf}`, channel: "DTEST", value: old })[0]?.text).toContain("expired");
    }
  }
});

test("delivery retries failed messages in order without replaying mutations", async () => {
  const t = table(0);
  const delivered: SlackMessage[] = [];
  let failing = true;
  let failures = 0;
  const delivery = new SlackDelivery(t.bot, async message => {
    if (failing) throw new Error("Slack unavailable");
    delivered.push(message);
  }, () => { failures++; });
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

test("werewolf victory at night opens a fresh lobby with a new host", () => {
  const t = table(5);
  t.command("start");
  reachNight(t);
  morning(t);
  openVoting(t);
  const state = t.lobby.game!.state();
  const target = state.players.find(p => p.alive && p.role === "Villager")!.id;
  for (const seat of state.pendingActors) t.choose(seat, target);
  morning(t);
  expect(t.lobby.game).toBeNull();
  const announcement = t.messages.find(m => m.destination === "channel" && m.text.startsWith("Werewolves win!"))!;
  expect(announcement.text).toContain("A new lobby is open!");
  expect(announcement.text).toContain("@Wolf join");
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
  let soloReadiness = 0;
  let eliminatedHumans = 0;
  for (const humans of [1, 2, 4, 5]) {
    for (let seed = 0n; seed < 30n; seed++) {
      const t = table(humans, seed, true);
      const start = t.command("start");
      expect(start[0]?.text).toContain("started with 5 players");
      expect(t.lobby.game!.state().phase).toBe("Day");
      expect(t.lobby.game!.state().players.every(p => p.alive)).toBe(true);
      expect(start.some(m => m.choices)).toBe(false);
      expect(start.filter(m => m.text.includes("You are Player")).length).toBe(humans);
      roles.add(start.find(m => m.user === "U0" && m.text.includes("You are Player"))!.text.split("a ")[1]!.split(".")[0]!);
      let turns = 0;
      while (t.lobby.game) {
        if (++turns > 20) throw new Error("Dev game did not finish");
        const game = t.lobby.game;
        const state = game.state();
        expect(state.players.length).toBe(5);
        const humanActors = state.pendingActors.filter(seat => seat < humans);
        expect(humanActors.length).toBeGreaterThan(0);
        if (state.phase === "Night") {
          const target = state.players.find(p => p.alive && p.role === "Villager")!.id;
          for (const seat of humanActors) t.choose(seat, target);
        } else {
          expect(state.votingOpen).toBe(false);
          expect(state.readyPlayers).toEqual([]);
          expect(t.dm(`U${humanActors[0]}`).some(m => m.choices)).toBe(false);
          expect(t.command("ready", "OUTSIDER")[0]?.text).toContain("not in an active game");
          const before = game.state();
          const ready = t.dm(`U${humanActors[0]}`, "ready");
          if (humans === 1) {
            soloReadiness++;
            expect(ready.some(m => m.choices)).toBe(true);
            expect(game.state().votingOpen).toBe(true);
            expect(game.state().round).toBe(before.round);
            expect(game.state().votes).toEqual([]);
            expect(t.command("ready")[0]?.text).toContain("already open");
          }
          openVoting(t);
          const target = state.players.find(p => p.alive && p.role === "Werewolf")!.id;
          for (const seat of humanActors) t.choose(seat, target);
        }
      }
      expect(t.messages.some(m => m.text.includes("win!"))).toBe(true);
      eliminatedHumans += t.messages.filter(m => m.destination === "dm" && m.text.startsWith("You were eliminated.")).length;
      expect(t.messages.every(m => m.destination === "channel" || m.user === "OUTSIDER" || /^U\d+$/.test(m.user!))).toBe(true);
      expect(t.messages.every(m => !m.text.includes("<@bot-"))).toBe(true);
      expect(t.lobby.members).toEqual([]);
      expect(t.lobby.host).toBeNull();
      for (let seat = 0; seat < humans; seat++) t.command("join", `U${seat}`);
      expect(t.command("start")[0]?.text).toContain("started with 5 players");
    }
  }
  expect(roles).toEqual(new Set(["Werewolf", "Villager"]));
  expect(soloReadiness).toBeGreaterThan(0);
  expect(eliminatedHumans).toBeGreaterThan(0);
});

test("scope errors explain bot reinstall or app token repair without dumping API data", () => {
  const data = { error: "missing_scope", needed: "channels:read,groups:read,mpim:read,im:read", provided: "channels:history,chat:write,commands", token: "xoxb-secret" };
  const message = slackErrorMessage({ data });
  expect(message).toContain("Token currently grants: channels:history, chat:write, commands");
  expect(message).toContain("Reinstall the app");
  expect(message).toContain("app_mentions:read");
  expect(message).not.toContain("xoxb-secret");
  const socket = slackErrorMessage({ original: { data: { error: "missing_scope", needed: "connections:write" } } });
  expect(socket).toContain("SLACK_APP_TOKEN");
  expect(socket).not.toContain("Bot Token Scopes");
  expect(slackErrorMessage(new Error("invalid_auth"))).toBe("invalid_auth");
});

test("Slack buttons cover all targets with unique action IDs and readable seat labels", () => {
  const t = table(12);
  t.command("start");
  const prompt = openVoting(t).find(m => m.choices)!;
  const blocks = messageBlocks(prompt)!;
  const actions = blocks.slice(1) as Array<{ elements: Array<{ action_id: string; value: string }> }>;
  expect(actions.map(block => block.elements.length)).toEqual([5, 5, 2]);
  expect(new Set(actions.flatMap(block => block.elements.map(button => button.action_id))).size).toBe(12);
  expect(prompt.text).toContain("12. <@U11>");
});
