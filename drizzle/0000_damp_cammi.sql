CREATE TABLE `game_players` (
	`game_id` text NOT NULL,
	`seat` integer NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`is_bot` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`game_id`, `seat`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_players_role" CHECK("game_players"."role" in ('Villager', 'Werewolf', 'Doctor', 'Seer')),
	CONSTRAINT "game_players_seat" CHECK("game_players"."seat" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_players_game_user` ON `game_players` (`game_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `game_players_user` ON `game_players` (`user_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`winner` text NOT NULL,
	`dev` integer DEFAULT false NOT NULL,
	CONSTRAINT "games_winner" CHECK("games"."winner" in ('Villagers', 'Werewolves'))
);
