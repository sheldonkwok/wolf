import { expect, test } from "bun:test";
import { Lobby } from "./lobby.js";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackInput, type SlackMessage } from "./slack/game.js";
import { messageBlocks, slackConfig, slackErrorMessage } from "./slackbot.js";

class SeededLobby extends Lobby {
  constructor(private seed: bigint) { super(); }
  override start(host: string) { return this.startWithSeed(host, this.seed); }
}

function table(count = 8, seed = 42n) {
  const lobby = new SeededLobby(seed);
  const bot = new SlackGame("CGAME", lobby);
  let sequence = 0;
  const messages: SlackMessage[] = [];
  const receive = (input: Omit<SlackInput, "id"> & { text?: string; value?: string }) => {
    const output = bot.handle({ ...input, id: `event-${sequence++}` } as SlackInput);
    messages.push(...output);
    return output;
  };
  const command = (text: string, user = "U0", channel = "CGAME") => receive({ kind: "mention", text, user, channel });
  const dm = (user: string) => receive({ kind: "dm", text: "status", user, channel: `D${user}` });
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

function morning(t: ReturnType<typeof table>) {
  const state = t.lobby.game!.state();
  const target = state.players.find(p => p.alive && p.role === "Villager")!.id;
  for (const wolf of state.pendingActors) t.choose(wolf, target);
  return target;
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
  expect(output.filter(m => m.choices).length).toBe(wolves.length);
  for (const player of state.players) {
    const role = output.find(m => m.user === `U${player.id}` && m.text.includes("You are Player"))!;
    expect(role.destination).toBe("dm");
    expect(role.text).toContain(player.role);
    expect(role.text.includes("Your pack:")).toBe(player.role === "Werewolf");
  }
  const publicText = output.filter(m => m.destination === "channel").map(m => m.text).join("\n");
  expect(publicText).not.toContain("<@U");
  const target = state.players.find(p => p.role === "Villager")!.id;
  expect(t.choose(wolves[0]!.id, target).every(m => m.destination === "dm")).toBe(true);
  expect(t.command("status")[0]?.text).not.toMatch(/pending|pack|Werewolf|Villager/);
});

test("night disagreement starts a private revote and invalidates old buttons", () => {
  const t = table();
  t.command("start");
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
  expect(t.command("vote", "U1")[0]?.text).toContain("Only the host");
  expect(t.command("vote").filter(m => m.choices).length).toBe(7);
  expect(t.command("vote")[0]?.text).toContain("already open");
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

test("a tied day advances to the next night and old day buttons expire", () => {
  const t = table(5);
  t.command("start");
  morning(t);
  t.command("vote");
  const living = t.lobby.game!.state().pendingActors;
  const old = t.value(`U${living[0]}`, living[0]!)!;
  for (const seat of living) t.choose(seat, seat);
  expect(t.lobby.game!.state().phase).toBe("Night");
  expect(t.lobby.game!.state().round).toBe(2);
  expect(t.messages.some(m => m.text.includes("vote was tied"))).toBe(true);
  expect(t.receive({ kind: "choice", user: `U${living[0]}`, channel: "DTEST", value: old })[0]?.text).toContain("expired");
});

test("real engine games finish for every lobby size and can restart", () => {
  for (let count = 5; count <= 12; count++) {
    for (let seed = 0n; seed < 10n; seed++) {
      const t = table(count, seed);
      t.command("start");
      const firstState = t.lobby.game!.state();
      const wolf = firstState.pendingActors[0]!;
      const old = t.value(`U${wolf}`, 0)!;
      let turns = 0;
      while (t.lobby.game) {
        if (++turns > 24) throw new Error("Game did not finish");
        const state = t.lobby.game.state();
        if (state.phase === "Night") morning(t);
        else {
          t.command("vote");
          const target = state.players.find(p => p.alive && p.role === "Werewolf")!.id;
          for (const seat of state.pendingActors) t.choose(seat, target);
        }
      }
      expect(t.messages.some(m => m.destination === "channel" && m.text.includes("win!"))).toBe(true);
      expect(t.lobby.size).toBe(count);
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

test("werewolf victory at night announces the winner and restores the lobby", () => {
  const t = table(5);
  t.command("start");
  morning(t);
  t.command("vote");
  const state = t.lobby.game!.state();
  const target = state.players.find(p => p.alive && p.role === "Villager")!.id;
  for (const seat of state.pendingActors) t.choose(seat, target);
  morning(t);
  expect(t.lobby.game).toBeNull();
  expect(t.messages.some(m => m.destination === "channel" && m.text.startsWith("Werewolves win!"))).toBe(true);
  t.command("leave");
  expect(t.lobby.host?.user).toBe("U1");
});

test("configuration requires tokens and a public channel ID without exposing secrets", () => {
  expect(() => slackConfig({})).toThrow("SLACK_BOT_TOKEN");
  const env = { SLACK_BOT_TOKEN: "xoxb-secret", SLACK_APP_TOKEN: "xapp-secret", SLACK_CHANNEL_ID: "CGAME" };
  expect(slackConfig(env).channel).toBe("CGAME");
  expect(() => slackConfig({ ...env, SLACK_CHANNEL_ID: "#werewolf" })).toThrow("SLACK_CHANNEL_ID");
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
  const prompt = t.command("start").find(m => m.choices)!;
  const blocks = messageBlocks(prompt)!;
  const actions = blocks.slice(1) as Array<{ elements: Array<{ action_id: string; value: string }> }>;
  expect(actions.map(block => block.elements.length)).toEqual([5, 5, 2]);
  expect(new Set(actions.flatMap(block => block.elements.map(button => button.action_id))).size).toBe(12);
  expect(prompt.text).toContain("12. <@U11>");
});
