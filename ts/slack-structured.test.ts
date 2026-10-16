// The 12-player structured game in Slack: the sheriff election, the 1.5 vote, the Fool, and Night 1 last words.

import { afterEach, expect, spyOn, test } from "bun:test";
import { Game, type Role } from "./engine.js";
import { Lobby } from "./lobby.js";
import { LAST_WORDS_COMMAND, structuredRules } from "./slack/copy.js";
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
  const choose = (seat: number, target: number | "pass") => {
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
  return { lobby, start, command, choose, state };
}

const channel = (output: SlackMessage[]) =>
  output.filter((m) => m.destination === "channel").map((m) => m.text);

test("a 12-player game announces structured rules and opens with a public sheriff election", () => {
  const t = table();
  const texts = channel(t.start);
  expect(texts[0]).toContain(structuredRules());
  expect(texts[1]).toStartWith(
    "Sheriff election. Every living player votes with `@werewolf sheriff @player`.",
  );
  expect(texts[1]).toContain("7 votes elect early");
  expect(t.start.some((m) => m.choices)).toBe(false);
  expect(t.state().phase).toBe("Sheriff");
  expect(t.command("vote <@U1>", 0)[0]?.text).toContain("requires Day phase");
  expect(t.command("last words hello", 0)[0]?.text).toContain("Only players eliminated on Night 1");

  expect(channel(t.command("sheriff <@U4>", 0))).toEqual([
    "<@U0> voted for <@U4> as sheriff (1/7 votes to elect early).",
  ]);
  expect(t.command("sheriff", 1)[0]?.text).toBe("Use `@werewolf sheriff @player` to mention one player.");
  expect(t.command("status")[0]?.text).toContain("Sheriff votes (7 to elect early");
  for (let seat = 1; seat < 6; seat++) t.command("sheriff <@U4>", seat);
  const elected = t.command("sheriff <@U4>", 6);
  const lines = channel(elected);
  expect(lines).toContain("<@U4> is elected sheriff! Their day vote counts as 1.5 votes.");
  const day = lines.find((line) => line.startsWith("Day 1."))!;
  expect(day).toContain("Sheriff <@U4>'s vote counts as 1.5 votes.");
  expect(elected.find((m) => m.choices)?.user).toBe("U8");
  expect(t.state().sheriff).toBe(4);
  expect(t.command("sheriff <@U5>", 7)[0]?.text).toBe("There is no sheriff election right now.");

  expect(channel(t.command("vote <@U0>", 4))).toEqual([
    "<@U4> voted for <@U0> (1.5/7 votes for an early majority).",
  ]);
  t.command("vote <@U0>", 5);
  expect(t.command("status")[0]?.text).toContain("<@U0> — 2.5 votes");
});

test("a tied sheriff election leaves the game without a sheriff", () => {
  const t = table();
  let output: SlackMessage[] = [];
  for (let seat = 0; seat < 12; seat++) output = t.command(`sheriff <@U${seat % 2}>`, seat);
  expect(channel(output)).toContain("The sheriff vote is tied. There is no sheriff this game.");
  expect(t.state().sheriff).toBeUndefined();
  expect(channel(output).find((line) => line.startsWith("Day 1."))).not.toContain("Sheriff");
});

test("the Fool survives a vote without a vote and Night 1 victims share last words once", () => {
  const t = table();
  for (let seat = 0; seat < 7; seat++) t.command("sheriff <@U11>", seat);
  let output: SlackMessage[] = [];
  for (let seat = 0; seat < 7; seat++) output = t.command("vote <@U11>", seat);
  expect(channel(output)).toContain(
    "<@U11> was voted out, but they are the Fool! They stay in the game but can no longer vote.",
  );
  expect(t.state().phase).toBe("Night");
  expect(t.state().sheriff).toBeUndefined();

  for (let wolf = 0; wolf < 4; wolf++) t.choose(wolf, 4);
  const seer = t.choose(8, 0);
  expect(seer.some((m) => m.user === "U9" && m.choices)).toBe(true);
  const dawn = t.choose(9, 5);
  const lines = channel(dawn);
  expect(lines).toContain(
    `<@U4> and <@U5> may share last words once with ${LAST_WORDS_COMMAND} before Day 2 ends.`,
  );
  expect(dawn.some((m) => m.user === "U4" && m.text.includes("Share your last words once"))).toBe(true);
  expect(lines.find((line) => line.startsWith("Day 2."))).toContain(
    "<@U11> is the revealed Fool and cannot vote.",
  );

  expect(t.command("vote <@U0>", 11)[0]?.text).toBe("You were revealed as the Fool and can no longer vote.");
  expect(t.command("last words", 4)[0]?.text).toBe(
    "Use `@werewolf last words <message>` to share your last words.",
  );
  expect(channel(t.command("last words P0 is a wolf, trust me", 4))).toEqual([
    "Last words from <@U4>: P0 is a wolf, trust me",
  ]);
  expect(t.command("lastwords again", 4)[0]?.text).toContain("Only players eliminated on Night 1");
  expect(t.command("last words me too", 6)[0]?.text).toContain("Only players eliminated on Night 1");
  expect(/Not voted: (.*)\./.exec(t.command("status")[0]!.text)![1]).not.toContain("U11");

  for (let seat = 6; seat < 11; seat++) t.command("vote <@U0>", seat);
  t.command("vote <@U0>", 1);
  expect(t.state().phase).toBe("Night");
  expect(t.command("last words too late", 5)[0]?.text).toContain("Only players eliminated on Night 1");
});
