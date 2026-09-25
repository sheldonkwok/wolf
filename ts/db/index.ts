import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  return {
    db,
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
