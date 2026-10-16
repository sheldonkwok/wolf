CREATE TABLE `lobbies` (
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `channel_id`)
);
