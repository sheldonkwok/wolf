import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { Role, Winner } from "../engine.js";
import * as schema from "./schema.js";

export interface FinishedGame {
  id: string;
  channelId: string;
  startedAt: Date;
  finishedAt: Date;
  winner: Winner;
  dev: boolean;
  players: { seat: number; userId: string; role: Role; isBot: boolean }[];
}

export interface TeamStats {
  played: number;
  wins: number;
  losses: number;
}

export interface PlayerStats extends TeamStats {
  village: TeamStats;
  wolves: TeamStats;
}

export interface ChannelStats {
  played: number;
  villageWins: number;
  wolfWins: number;
  topWolves: { userId: string; count: number }[];
}

export function openStats(path = process.env.DATABASE_PATH || "./data/wolf.sqlite") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true, strict: true });
  const db = drizzle(sqlite, { schema });
  try {
    sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const scope = (workspaceId: string, channelId: string) =>
    and(
      eq(schema.games.workspaceId, workspaceId),
      eq(schema.games.channelId, channelId),
      eq(schema.games.dev, false),
    );
  return {
    db,
    personal(workspaceId: string, channelId: string, userId: string): PlayerStats {
      const rows = db
        .select({ role: schema.gamePlayers.role, winner: schema.games.winner, count: count() })
        .from(schema.gamePlayers)
        .innerJoin(schema.games, eq(schema.games.id, schema.gamePlayers.gameId))
        .where(
          and(
            scope(workspaceId, channelId),
            eq(schema.gamePlayers.userId, userId),
            eq(schema.gamePlayers.isBot, false),
          ),
        )
        .groupBy(schema.gamePlayers.role, schema.games.winner)
        .all();
      const village: TeamStats = { played: 0, wins: 0, losses: 0 };
      const wolves: TeamStats = { played: 0, wins: 0, losses: 0 };
      for (const row of rows) {
        const isWolf = row.role === "Werewolf";
        const team = isWolf ? wolves : village;
        team.played += row.count;
        if (isWolf === (row.winner === "Werewolves")) team.wins += row.count;
        else team.losses += row.count;
      }
      return {
        played: village.played + wolves.played,
        wins: village.wins + wolves.wins,
        losses: village.losses + wolves.losses,
        village,
        wolves,
      };
    },
    channel(workspaceId: string, channelId: string): ChannelStats {
      const wins = db
        .select({ winner: schema.games.winner, count: count() })
        .from(schema.games)
        .where(scope(workspaceId, channelId))
        .groupBy(schema.games.winner)
        .all();
      const villageWins = wins.find((row) => row.winner === "Villagers")?.count ?? 0;
      const wolfWins = wins.find((row) => row.winner === "Werewolves")?.count ?? 0;
      const topWolves = db
        .select({ userId: schema.gamePlayers.userId, count: count() })
        .from(schema.gamePlayers)
        .innerJoin(schema.games, eq(schema.games.id, schema.gamePlayers.gameId))
        .where(
          and(
            scope(workspaceId, channelId),
            eq(schema.gamePlayers.role, "Werewolf"),
            eq(schema.gamePlayers.isBot, false),
          ),
        )
        .groupBy(schema.gamePlayers.userId)
        .orderBy(desc(count()), asc(schema.gamePlayers.userId))
        .limit(3)
        .all();
      return { played: villageWins + wolfWins, villageWins, wolfWins, topWolves };
    },
    record(workspaceId: string, result: FinishedGame): void {
      db.transaction((tx) => {
        const { players, ...game } = result;
        const inserted = tx
          .insert(schema.games)
          .values({ ...game, workspaceId })
          .onConflictDoNothing({ target: schema.games.id })
          .returning({ id: schema.games.id })
          .get();
        if (!inserted) return;
        if (players.length === 0) throw new Error("A completed game must have players.");
        tx.insert(schema.gamePlayers)
          .values(players.map((player) => ({ ...player, gameId: game.id })))
          .run();
      });
    },
    close: () => sqlite.close(),
  };
}
