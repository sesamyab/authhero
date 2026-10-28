CREATE TABLE `device_codes` (
	`tenant_id` text NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`scope` text,
	`audience` text,
	`status` text NOT NULL,
	`login_id` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_polled_at` text,
	`interval` integer NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `device_code_hash`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_idx` ON `device_codes` (`tenant_id`,`user_code_hash`);--> statement-breakpoint
CREATE INDEX `device_codes_expiry_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `device_flow_limits` (
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` text NOT NULL,
	PRIMARY KEY(`tenant_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `device_flow_limits_expiry_idx` ON `device_flow_limits` (`expires_at`);