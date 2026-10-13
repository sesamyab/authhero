CREATE TABLE `prompt_partials` (
	`tenant_id` text(191) NOT NULL,
	`prompt` text(64) NOT NULL,
	`body` text NOT NULL,
	`created_at_ts` integer NOT NULL,
	`updated_at_ts` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `prompt`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
