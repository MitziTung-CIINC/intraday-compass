CREATE TABLE `actual_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`time` text NOT NULL,
	`code` text NOT NULL,
	`side` text NOT NULL,
	`quantity` integer NOT NULL,
	`price` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL
);
