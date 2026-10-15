CREATE TABLE `organization_connections` (
	`tenant_id` text(191) NOT NULL,
	`organization_id` text(21) NOT NULL,
	`connection_id` text(191) NOT NULL,
	`assign_membership_on_login` integer DEFAULT 0 NOT NULL,
	`show_as_button` integer DEFAULT 1 NOT NULL,
	`is_signup_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL,
	PRIMARY KEY(`tenant_id`, `organization_id`, `connection_id`)
);
--> statement-breakpoint
CREATE TABLE `log_streams` (
	`id` text(64) PRIMARY KEY NOT NULL,
	`tenant_id` text(191) NOT NULL,
	`name` text(255) NOT NULL,
	`type` text(64) NOT NULL,
	`status` text(32) NOT NULL,
	`sink` text NOT NULL,
	`filters` text,
	`is_priority` integer,
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_log_streams_tenant_id` ON `log_streams` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `migration_sources` (
	`id` text(64) PRIMARY KEY NOT NULL,
	`tenant_id` text(191) NOT NULL,
	`name` text(255) NOT NULL,
	`provider` text(32) NOT NULL,
	`connection` text(255) NOT NULL,
	`enabled` integer NOT NULL,
	`credentials` text NOT NULL,
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_migration_sources_tenant_id` ON `migration_sources` (`tenant_id`);