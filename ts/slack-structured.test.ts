// The 12-player structured game in Slack: Night 1 first, the sheriff election and badge, the 1.5 vote, the Fool, and last words.

import { afterEach, expect, spyOn, test } from "bun:test";
import { Game, type Role } from "./engine.js";
import { Lobby } from "./lobby.js";
import { LAST_WORDS_COMMAND, NOMINATE_COMMANDS, structuredRules } from "./slack/copy.js";
import { SlackGame, type SlackInput, type SlackMessage } from "./slack/game.js";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

class FixedLobby extends Lobby {
  override start(host: string) {
    return this.startWithSeed(host, 0n);
  }
}

// P0-P3 wolves, P4-P7 villagers, P8 Seer, P9 Witch, P10 Hunter, P11 Fool.
const STRUCTURED = [
  ...Array<Role>(4).fill("Werewolf"),
  ...Array<Role>(4).fill("Villager"),
  "Seer",
  "Witch",
  "Hunter",
  "Fool",
] as Role[];

function table() {
  spies.push(spyOn(Game, "withSeed").mockImplementation(() => Game.withRuleset(STRUCTURED, "Structured")));
  const lobby = new FixedLobby();
  const bot = new SlackGame("CGAME", lobby, { seed: 1n });
  let sequence = 0;
  const receive = (input: Omit<SlackInput, "id"> & { text?: string; value?: string }) =>
    bot.handle({ ...input, id: `event-${sequence++}` } as SlackInput);
  const command = (text: string, seat = 0) =>
    receive({ kind: "mention", text, user: `U${seat}`, channel: "CGAME" });
  const choose = (seat: number, target: number | "pass" | "tear") => {
    const prompt = receive({ kind: "dm", text: "status", user: `U${seat}`, channel: `DU${seat}` }).find(
      (m) => m.choices,
    );
    const choice = prompt?.choices?.find((c) => c.value.endsWith(`:${target}`));
    if (!choice) throw new Error(`No option ${target} for seat ${seat}`);
    return receive({ kind: "choice", user: `U${seat}`, channel: `DU${seat}`, value: choice.value });
  };
  for (let seat = 0; seat < 12; seat++) command("join", seat);
  const start = command("start");
  const state = () => lobby.game!.state();
  // The pack attacks `target`, the Seer looks at P0, and the Witch makes `witch`; returns the Witch's output.
  const night = (target: number, witch: number | "pass" = "pass") => {
    for (let wolf = 0; wolf < 4; wolf++) choose(wolf, target);
    choose(8, 0);
    return choose(9, witch);
  };
  // Every player declares, with only `candidates` running; returns the last output.
  const declare = (candidates: number[]) => {
    let output: SlackMessage[] = [];
    for (let seat = 0; seat < 12; seat++) output = command(candidates.includes(seat) ? "run" : "pass", seat);
    return output;
  };
  return { lobby, start, command, choose, state, night, declare };
}

const channel = (output: SlackMessage[]) =>
  output.filter((m) => m.destination === "channel").map((m) => m.text);

test("a 12-player game opens at night and elects a sheriff before the Night 1 report", () => {
  const t = table();
  const texts = channel(t.start);
  expect(texts[0]).toContain(structuredRules());
  expect(texts[1]).toStartWith("Night 1. The village sleeps.");
  expect(t.start.filter((m) => m.choices).map((m) => m.user)).toEqual(["U0", "U1", "U2", "U3", "U8"]);
  expect(t.state().phase).toBe("Night");

  const morning = channel(t.night(5));
  expect(morning).toHaveLength(1);
  expect(morning[0]).toStartWith("Morning breaks. Before the night's report, the village elects a sheriff");
  expect(morning[0]).toContain(NOMINATE_COMMANDS);
  expect(t.state().phase).toBe("Sheriff");
  expect(t.command("sheriff <@U4>", 0)[0]?.text).toBe(
    `Voting starts once everyone has declared with ${NOMINATE_COMMANDS}.`,
  );
  expect(t.command("withdraw", 4)[0]?.text).toBe(
    "Only a sheriff candidate can withdraw once voting has started.",
  );
  expect(t.command("vote <@U1>", 0)[0]?.text).toContain("requires Day phase");
  expect(channel(t.command("run", 4))).toEqual(["<@U4> is running for sheriff (1/12 declared)."]);
  expect(channel(t.command("run", 5))).toEqual(["<@U5> is running for sheriff (2/12 declared)."]);
  expect(t.command("status")[0]?.text).toContain("Running: <@U4>, <@U5>.");

  const open = channel(t.declare([4, 6]));
  expect(open).toContain("<@U11> is not running for sheriff (12/12 declared).");
  const voting = open.find((line) => line.startsWith("Sheriff voting is open."))!;
  expect(voting).toContain("Candidates: <@U4>, <@U6>.");
  expect(voting).toContain("6 votes elect early");
  expect(t.command("run", 7)[0]?.text).toBe("Candidacy is closed; sheriff voting has started.");
  expect(t.command("sheriff <@U6>", 4)[0]?.text).toBe(
    "Sheriff candidates, including those who withdrew, cannot vote.",
  );
  expect(t.command("sheriff <@U7>", 0)[0]?.text).toBe("Vote for a candidate: <@U4>, <@U6>.");
  expect(channel(t.command("sheriff <@U4>", 5))).toEqual([
    "<@U5> voted for <@U4> as sheriff (1/6 votes to elect early).",
  ]);
  expect(t.command("status")[0]?.text).toContain("Sheriff election. Candidates: <@U4>, <@U6>.");
  for (const seat of [0, 1, 2, 3]) t.command("sheriff <@U4>", seat);
  const lines = channel(t.command("sheriff <@U4>", 7));
  const elected = lines.indexOf("<@U4> is elected sheriff! Their day vote counts as 1.5 votes.");
  const death = lines.indexOf("<@U5> was eliminated during the night. Their role was Villager.");
  expect(elected).toBeGreaterThanOrEqual(0);
  expect(death).toBeGreaterThan(elected);
  expect(lines).toContain(`<@U5> may share last words once with ${LAST_WORDS_COMMAND} before Day 1 ends.`);
  const day = lines.find((line) => line.startsWith("Day 1."))!;
  expect(day).toContain("Sheriff <@U4>'s vote counts as 1.5 votes.");
  expect(t.state().sheriff).toBe(4);
  expect(t.state().pendingInspectors).toEqual([]);

  expect(channel(t.command("vote <@U0>", 4))).toEqual([
    "<@U4> voted for <@U0> (1.5/6 votes for an early majority).",
  ]);
  t.command("vote <@U0>", 6);
  expect(t.command("status")[0]?.text).toContain("<@U0> — 2.5 votes");
});

test("a lone candidate wins unopposed, including after the others withdraw", () => {
  const t = table();
  t.night(5);
  expect(channel(t.declare([4]))).toContain("<@U4> is the only candidate.");
  expect(t.state().sheriff).toBe(4);
  expect(t.state().phase).toBe("Day");

  const u = table();
  u.night(5);
  u.declare([4, 6]);
  u.command("sheriff <@U6>", 0);
  const lines = channel(u.command("withdraw", 6));
  expect(lines[0]).toBe("<@U6> withdrew from the sheriff race. Votes for them are cleared.");
  expect(lines).toContain("<@U4> is elected sheriff! Their day vote counts as 1.5 votes.");
});

test("with no candidates there is no sheriff", () => {
  const t = table();
  t.night(5);
  const lines = channel(t.declare([]));
  expect(lines).toContain("Nobody is running for sheriff.");
  expect(lines).toContain("No sheriff was elected this game.");
  expect(t.state().sheriff).toBeUndefined();
  expect(lines.find((line) => line.startsWith("Day 1."))).not.toContain("Sheriff");
});

test("a sheriff killed on Night 1 passes the badge from a DM dropdown", () => {
  const t = table();
  t.night(5);
  t.declare([5, 6]);
  let output: SlackMessage[] = [];
  for (const seat of [0, 1, 2, 3, 4, 7]) output = t.command("sheriff <@U5>", seat);
  const lines = channel(output);
  expect(lines).toContain("<@U5> is elected sheriff! Their day vote counts as 1.5 votes.");
  expect(lines).toContain(
    "<@U5> held the sheriff's badge. Play pauses until they pass it to a living player or tear it up in their DMs.",
  );
  expect(lines.some((line) => line.startsWith("Day 1."))).toBe(false);
  const prompt = output.find((m) => m.user === "U5" && m.choices)!;
  expect(prompt.choices![0]).toMatchObject({ label: "Tear up the badge" });
  expect(prompt.choices!.some((c) => c.value.endsWith(":5"))).toBe(false);
  expect(t.command("vote <@U0>", 0)[0]?.text).toContain("requires Day phase");
  const passed = channel(t.choose(5, 7));
  expect(passed[0]).toBe("<@U5> passed the sheriff's badge to <@U7>. Their day vote counts as 1.5 votes.");
  expect(passed[1]).toContain("Sheriff <@U7>'s vote counts as 1.5 votes.");
  expect(t.state().sheriff).toBe(7);
});

test("a voted-out sheriff can tear up the badge", () => {
  const t = table();
  t.night(5);
  t.declare([4]);
  let output: SlackMessage[] = [];
  for (const seat of [0, 1, 2, 3, 6, 7]) output = t.command("vote <@U4>", seat);
  expect(t.state().phase).toBe("Badge");
  expect(output.some((m) => m.user === "U4" && m.choices)).toBe(true);
  const torn = channel(t.choose(4, "tear"));
  expect(torn[0]).toBe("<@U4> tore up the sheriff's badge. There is no sheriff now.");
  expect(torn[1]).toStartWith("Night 2.");
  expect(t.state().sheriff).toBeUndefined();
});

test("a poisoned Hunter cannot shoot, the Fool survives a vote, and last words expire with Day 1", () => {
  const t = table();
  t.night(5, 10);
  const lines = channel(t.declare([]));
  expect(lines).toContain("<@U10> was eliminated during the night. Their role was Hunter.");
  expect(lines).toContain(
    `<@U5> and <@U10> may share last words once with ${LAST_WORDS_COMMAND} before Day 1 ends.`,
  );
  expect(lines.some((line) => line.includes("final shot"))).toBe(false);
  expect(t.state().phase).toBe("Day");

  expect(t.command("last words", 5)[0]?.text).toBe(
    "Use `@werewolf last words <message>` to share your last words.",
  );
  expect(channel(t.command("last words P0 is a wolf, trust me", 5))).toEqual([
    "Last words from <@U5>: P0 is a wolf, trust me",
  ]);
  expect(t.command("lastwords again", 5)[0]?.text).toContain("Only players eliminated on Night 1");
  expect(t.command("last words me too", 6)[0]?.text).toContain("Only players eliminated on Night 1");

  let output: SlackMessage[] = [];
  for (const seat of [0, 1, 2, 3, 4, 6]) output = t.command("vote <@U11>", seat);
  expect(channel(output)).toContain(
    "<@U11> was voted out, but they are the Fool! They stay in the game but can no longer vote.",
  );
  expect(t.state().phase).toBe("Night");
  expect(t.command("last words too late", 10)[0]?.text).toContain("Only players eliminated on Night 1");
  const day = channel(t.night(4)).find((line) => line.startsWith("Day 2."))!;
  expect(day).toContain("<@U11> is the revealed Fool and cannot vote.");
  expect(t.command("vote <@U0>", 11)[0]?.text).toBe("You were revealed as the Fool and can no longer vote.");
  expect(/Not voted: (.*)\./.exec(t.command("status")[0]!.text)![1]).not.toContain("U11");
});
