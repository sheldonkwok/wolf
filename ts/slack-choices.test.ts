import { expect, test } from "bun:test";
import type { App } from "@slack/bolt";
import { SlackDelivery } from "./slack/delivery.js";
import { SlackGame, type SlackMessage } from "./slack/game.js";
import { choiceNameResolver, messageBlocks } from "./slackbot.js";

const prompt: SlackMessage = {
  destination: "dm",
  user: "U1",
  text: "Choose a player",
  choices: [{ slackUser: "U1", label: "U1", value: "opaque:unchanged" }],
};

function resolver(info: (args: { user: string }) => Promise<unknown>) {
  return choiceNameResolver({ users: { info } } as unknown as App["client"]);
}

test("names prefer full names, then display name, username and ID, ignoring blank fields", async () => {
  const cases = [
    [{ profile: { real_name: " Full Name ", display_name: "Display" }, real_name: "Other" }, "Full Name"],
    [
      { profile: { real_name: "  ", display_name: "Display" }, real_name: "Other Full Name" },
      "Other Full Name",
    ],
    [{ profile: { display_name: "Display" }, name: "username" }, "Display"],
    [{ name: "username" }, "username"],
    [{ profile: { real_name: "", display_name: " " } }, "U1"],
  ] as const;
  for (const [user, expected] of cases) {
    const resolve = resolver(async () => ({ ok: true, user }));
    const result = await resolve(prompt);
    expect(result.choices![0]!.label).toBe(expected);
    expect(result.choices![0]!.value).toBe("opaque:unchanged");
    expect(prompt.choices![0]!.label).toBe("U1");
  }
});

test("successful names are cached across prompts; bot choices never call users.info", async () => {
  const calls: string[] = [];
  const resolve = resolver(async ({ user }) => {
    calls.push(user);
    return { ok: true, user: { real_name: "Human Full Name" } };
  });
  await resolve(prompt);
  const result = await resolve({
    ...prompt,
    choices: [...prompt.choices!, { label: "Bot 1", value: "not:a:user" }],
  });
  expect(calls).toEqual(["U1"]);
  expect(result.choices!.map((choice) => choice.label)).toEqual(["Human Full Name", "Bot 1"]);
});

test("lookup errors are not cached and delivery retries without numbered fallback", async () => {
  let calls = 0;
  const resolve = resolver(async () => {
    if (++calls === 1) throw new Error("missing_scope");
    return { ok: true, user: { real_name: "Recovered Full Name" } };
  });
  const game = { handle: () => [prompt], saveResults: () => {} } as unknown as SlackGame;
  const sent: SlackMessage[] = [];
  const delivery = new SlackDelivery(
    game,
    async (message) => {
      sent.push(await resolve(message));
    },
    () => {},
  );
  await delivery.receive({ id: "event", kind: "dm", user: "U1", channel: "D1", text: "status" });
  expect(sent).toHaveLength(0);
  await delivery.retry();
  expect(sent[0]!.choices![0]!.label).toBe("Recovered Full Name");
  expect(calls).toBe(2);
  await expect(resolver(async () => ({ ok: false, error: "ratelimited" }))(prompt)).rejects.toThrow(
    "ratelimited",
  );
});

test("dropdowns split at 100 options, truncate Unicode labels, and preserve opaque values", () => {
  const choices = Array.from({ length: 205 }, (_, index) => ({
    label: "𝒜".repeat(80),
    value: `opaque-${index}`,
  }));
  const blocks = messageBlocks({ ...prompt, choices })!;
  const menus = blocks.slice(1).flatMap((block) => ("elements" in block ? block.elements : []));
  expect(menus.map((menu) => menu.options.length)).toEqual([100, 100, 5]);
  expect(new Set(menus.map((menu) => menu.action_id)).size).toBe(3);
  expect(menus.every((menu) => menu.type === "static_select")).toBe(true);
  const options = menus.flatMap((menu) => menu.options);
  expect(options.map((option) => option.value)).toEqual(choices.map((choice) => choice.value));
  expect(options.every((option) => Array.from(option.text.text).length === 75)).toBe(true);
  expect(messageBlocks({ destination: "channel", text: "No choices" })).toBeUndefined();
});

test("dev prompts carry stored bot names and human IDs, never bot lookup metadata", () => {
  let found = false;
  for (let seed = 0n; seed < 40n; seed++) {
    const game = new SlackGame("C1", undefined, { dev: true, seed });
    game.handle({ id: "join", kind: "mention", user: "U1", channel: "C1", text: "join" });
    game.handle({ id: "start", kind: "mention", user: "U1", channel: "C1", text: "start" });
    const messages = game.handle({ id: "status", kind: "dm", user: "U1", channel: "D1", text: "status" });
    for (const choice of messages.flatMap((message) => message.choices ?? [])) {
      found = true;
      if (choice.slackUser) expect(choice.slackUser).toBe("U1");
      else expect(choice.label).toMatch(/^Bot [1-4]$/);
    }
  }
  expect(found).toBe(true);
});
