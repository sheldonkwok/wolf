import { expect, test } from "bun:test";
import { type FinishedGame, openStats } from "./db/index.js";
import { Lobby } from "./lobby.js";
import { SlackGame } from "./slack/game.js";

function result(role: FinishedGame["players"][number]["role"], winner: FinishedGame["winner"]): FinishedGame {
  return {
    id: crypto.randomUUID(),
    channelId: "C1",
    startedAt: new Date(1_000),
    finishedAt: new Date(2_000),
    winner,
    dev: false,
    players: [{ seat: 0, userId: "U1", role, isBot: false }],
  };
}

function setup() {
  const stats = openStats(":memory:");
  const game = new SlackGame("C1", undefined, {
    playerStats: (user) => stats.personal("T1", "C1", user),
    channelStats: () => stats.channel("T1", "C1"),
  });
  const send = (kind: "mention" | "dm", text = "stats", user = "U1", channel?: string) =>
    game.handle({
      id: crypto.randomUUID(),
      kind,
      text,
      user,
      channel: channel ?? (kind === "dm" ? "D1" : "C1"),
    });
  return { stats, game, send };
}

test("stats count wins and losses for every village role and wolves, scoped to real games", () => {
  const { stats, send } = setup();
  try {
    for (const role of ["Doctor", "Seer", "Hunter", "Villager", "Werewolf"] as const) {
      for (const winner of ["Villagers", "Werewolves"] as const) stats.record("T1", result(role, winner));
    }
    const ignored = result("Werewolf", "Werewolves");
    stats.record("T2", ignored);
    stats.record("T1", { ...ignored, id: "other-channel", channelId: "C2" });
    stats.record("T1", { ...ignored, id: "dev", dev: true });
    const expected = {
      played: 10,
      wins: 5,
      losses: 5,
      village: { played: 8, wins: 4, losses: 4 },
      wolves: { played: 2, wins: 1, losses: 1 },
    };
    expect(stats.personal("T1", "C1", "U1")).toEqual(expected);
    expect(stats.channel("T1", "C1")).toEqual({
      played: 10,
      villageWins: 5,
      wolfWins: 5,
      topWolves: [{ userId: "U1", count: 2 }],
    });
    const messages = send("dm", "  StAtS  ");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ destination: "dm", user: "U1" });
    expect(messages[0]!.text).toContain("Overall: 10 played · 5 wins · 5 losses · 50.0% win rate");
    expect(messages[0]!.text).toContain("Village team: 8 played · 4 wins · 4 losses");
    expect(messages[0]!.text).toContain("Werewolf team: 2 played · 1 wins · 1 losses");
    expect(send("dm", "stats", "U2")[0]!.text).toContain("You haven't completed any games yet");
  } finally {
    stats.close();
  }
});

test("channel rates count games, rankings count assignments not wins, and bots are excluded", () => {
  const { stats, send } = setup();
  try {
    for (let index = 0; index < 4; index++) {
      const game = result("Villager", index === 0 ? "Werewolves" : "Villagers");
      game.players = ["UBOT", "U4", "U3", "U2", "U1"]
        .filter((user) => user === "UBOT" || user === "U4" || index < 2)
        .map((userId, seat) => ({ seat, userId, role: "Werewolf", isBot: userId === "UBOT" }));
      stats.record("T1", game);
      stats.record("T1", game);
    }
    expect(stats.channel("T1", "C1")).toEqual({
      played: 4,
      villageWins: 3,
      wolfWins: 1,
      topWolves: [
        { userId: "U4", count: 4 },
        { userId: "U1", count: 2 },
        { userId: "U2", count: 2 },
      ],
    });
    expect(stats.personal("T1", "C1", "UBOT").played).toBe(0);
    const messages = send("mention", " STATS ", "SPECTATOR");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.destination).toBe("channel");
    expect(messages[0]!.text).toContain("Village team: 3 wins · 75.0% win rate");
    expect(messages[0]!.text).toContain("Werewolf team: 1 wins · 25.0% win rate");
    expect(messages[0]!.text).toContain("1. <@U4> — 4 times\n2. <@U1> — 2 times\n3. <@U2> — 2 times");
    expect(messages[0]!.text).not.toContain("UBOT");
    expect(send("mention", "stats", "U1", "C2")).toEqual([]);
  } finally {
    stats.close();
  }
});

test("empty history is safe and help advertises both stats commands", () => {
  const { stats, send } = setup();
  try {
    for (const kind of ["mention", "dm"] as const) {
      const text = send(kind)[0]!.text;
      expect(text).toContain("N/A win rate");
      expect(text).not.toMatch(/NaN|Infinity/);
    }
    expect(send("mention")[0]!.text).toContain("No completed games yet");
    const help = send("mention", "help")[0]!.text;
    expect(help).toContain("DM `stats`");
    expect(help).toContain("`@werewolf stats`");
  } finally {
    stats.close();
  }
});

test("stats during an active game reveal no current roles and duplicate requests are ignored", () => {
  const stats = openStats(":memory:");
  try {
    const lobby = new Lobby();
    for (let index = 0; index < 5; index++) lobby.join(`U${index}`, `Player ${index}`);
    const game = new SlackGame("C1", lobby, {
      playerStats: (user) => stats.personal("T1", "C1", user),
      channelStats: () => stats.channel("T1", "C1"),
    });
    game.handle({ id: "start", kind: "mention", channel: "C1", user: "U0", text: "start" });
    const before = lobby.game!.state();
    for (const kind of ["mention", "dm"] as const) {
      const input = { id: kind, kind, channel: kind === "dm" ? "D1" : "C1", user: "U0", text: "stats" };
      const messages = game.handle(input);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain(kind === "dm" ? "0 played" : "0 completed games");
      expect(messages[0]!.text).not.toContain("<@U");
      expect(messages[0]!.choices).toBeUndefined();
      expect(game.handle(input)).toEqual([]);
    }
    expect(lobby.game!.state()).toEqual(before);
  } finally {
    stats.close();
  }
});
