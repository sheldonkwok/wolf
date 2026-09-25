import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const games = sqliteTable(
  "games",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
    winner: text("winner", { enum: ["Villagers", "Werewolves"] }).notNull(),
    dev: integer("dev", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [check("games_winner", sql`${table.winner} in ('Villagers', 'Werewolves')`)],
);

export const gamePlayers = sqliteTable(
  "game_players",
  {
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seat: integer("seat").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["Villager", "Werewolf", "Doctor", "Seer", "Hunter"] }).notNull(),
    isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.gameId, table.seat] }),
    uniqueIndex("game_players_game_user").on(table.gameId, table.userId),
    index("game_players_user").on(table.userId),
    check("game_players_role", sql`${table.role} in ('Villager', 'Werewolf', 'Doctor', 'Seer', 'Hunter')`),
    check("game_players_seat", sql`${table.seat} >= 0`),
  ],
);
