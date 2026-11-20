CREATE TABLE `connection_domains` (
	`id` text(64) PRIMARY KEY NOT NULL,
	`tenant_id` text(191) NOT NULL,
	`connection_id` text(255) NOT NULL,
	`domain` text(255) NOT NULL,
	`status` text(16) NOT NULL,
	`verification_value` text(255) NOT NULL,
	`verified_at` text(35),
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_domains_tenant_connection_domain_idx` ON `connection_domains` (`tenant_id`,`connection_id`,`domain`);--> statement-breakpoint
CREATE INDEX `connection_domains_tenant_domain_idx` ON `connection_domains` (`tenant_id`,`domain`);--> statement-breakpoint
CREATE TABLE `self_service_profile_custom_texts` (
	`tenant_id` text(191) NOT NULL,
	`profile_id` text(64) NOT NULL,
	`language` text(32) NOT NULL,
	`page` text(64) NOT NULL,
	`custom_text` text NOT NULL,
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL,
	PRIMARY KEY(`tenant_id`, `profile_id`, `language`, `page`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `self_service_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `self_service_profiles` (
	`id` text(64) PRIMARY KEY NOT NULL,
	`tenant_id` text(191) NOT NULL,
	`name` text(255) NOT NULL,
	`description` text(255),
	`allowed_strategies` text,
	`user_attributes` text,
	`branding` text,
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `self_service_profiles_tenant_id_idx` ON `self_service_profiles` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `sso_access_tickets` (
	`id` text(64) PRIMARY KEY NOT NULL,
	`tenant_id` text(191) NOT NULL,
	`profile_id` text(64) NOT NULL,
	`ticket_hash` text(128) NOT NULL,
	`connection_id` text(255),
	`connection_config` text,
	`enabled_clients` text,
	`enabled_organizations` text,
	`domain_verification` text(16) NOT NULL,
	`expires_at` text(35) NOT NULL,
	`revoked_at` text(35),
	`completed_at` text(35),
	`created_at` text(35) NOT NULL,
	`updated_at` text(35) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `self_service_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sso_access_tickets_ticket_hash_idx` ON `sso_access_tickets` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `sso_access_tickets_tenant_profile_idx` ON `sso_access_tickets` (`tenant_id`,`profile_id`);