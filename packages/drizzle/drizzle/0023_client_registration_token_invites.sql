ALTER TABLE `client_registration_tokens` ADD `name` text(255);--> statement-breakpoint
ALTER TABLE `client_registration_tokens` ADD `created_by` text(255);--> statement-breakpoint
ALTER TABLE `client_registration_tokens` ADD `source` text(16);--> statement-breakpoint
CREATE INDEX `idx_client_registration_tokens_created` ON `client_registration_tokens` (`tenant_id`,`created_at_ts`);