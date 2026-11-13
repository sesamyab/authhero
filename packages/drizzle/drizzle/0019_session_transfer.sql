ALTER TABLE `refresh_tokens` ADD `session_transfer` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `session_transfer` text;