import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FinishedGame, openStats } from "./db/index.js";
import { gamePlayers, games } from "./db/schema.js";

function result(): FinishedGame {
  return {
    id: crypto.randomUUID(),
    channelId: "CGAME",
    startedAt: new Date(1_000),
    finishedAt: new Date(2_000),
    winner: "Villagers",
    dev: false,
    players: ["Werewolf", "Doctor", "Seer", "Villager", "Villager"].map((role, seat) => ({
      seat,
      userId: `U${seat}`,
      role: role as FinishedGame["players"][number]["role"],
      isBot: false,
    })),
  };
}

test("migrations and game results survive reopening a SQLite file", () => {
  const directory = mkdtempSync(join(tmpdir(), "wolf-stats-"));
  const path = join(directory, "nested", "wolf.sqlite");
  const game = result();
  try {
    const stats = openStats(path);
    try {
      stats.record("TWORKSPACE", game);
      stats.record("TWORKSPACE", game);
      expect(stats.db.select().from(games).all()).toHaveLength(1);
      expect(stats.db.select().from(gamePlayers).all()).toHaveLength(5);
    } finally {
      stats.close();
    }
    const reopened = openStats(path);
    try {
      const { players, ...metadata } = game;
      expect(reopened.db.select().from(games).all()).toEqual([{ ...metadata, workspaceId: "TWORKSPACE" }]);
      expect(reopened.db.select().from(gamePlayers).orderBy(gamePlayers.seat).all()).toEqual(
        players.map((player) => ({ ...player, gameId: game.id })),
      );
      reopened.record("TWORKSPACE", { ...game, id: "second", winner: "Werewolves", dev: true });
      expect(reopened.db.select().from(games).all()).toHaveLength(2);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("game and roster writes are atomic and invalid rosters can be retried", () => {
  const stats = openStats(":memory:");
  const game = result();
  try {
    for (const players of [[], [...game.players, game.players[0]!]]) {
      expect(() => stats.record("TWORKSPACE", { ...game, players })).toThrow();
      expect(stats.db.select().from(games).all()).toEqual([]);
      expect(stats.db.select().from(gamePlayers).all()).toEqual([]);
    }
    expect(() =>
      stats.db
        .insert(gamePlayers)
        .values({ ...game.players[0]!, gameId: "missing" })
        .run(),
    ).toThrow();
    stats.record("TWORKSPACE", game);
    expect(stats.db.select().from(gamePlayers).all()).toHaveLength(5);
  } finally {
    stats.close();
  }
});
