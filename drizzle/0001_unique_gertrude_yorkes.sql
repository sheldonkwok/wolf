PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_game_players` (
	`game_id` text NOT NULL,
	`seat` integer NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`is_bot` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`game_id`, `seat`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_players_role" CHECK("__new_game_players"."role" in ('Villager', 'Werewolf', 'Doctor', 'Seer', 'Hunter')),
	CONSTRAINT "game_players_seat" CHECK("__new_game_players"."seat" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_game_players`("game_id", "seat", "user_id", "role", "is_bot") SELECT "game_id", "seat", "user_id", "role", "is_bot" FROM `game_players`;--> statement-breakpoint
DROP TABLE `game_players`;--> statement-breakpoint
ALTER TABLE `__new_game_players` RENAME TO `game_players`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `game_players_game_user` ON `game_players` (`game_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `game_players_user` ON `game_players` (`user_id`);