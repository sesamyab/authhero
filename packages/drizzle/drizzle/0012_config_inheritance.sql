ALTER TABLE `tenants` ADD `parent_tenant_id` text(191);--> statement-breakpoint
ALTER TABLE `actions` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `actions` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `actions` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `connections` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `connections` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `resource_servers` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `resource_servers` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `resource_servers` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `branding` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `branding` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `branding` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `email_providers` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `email_providers` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `email_providers` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `hooks` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `hooks` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `hooks` ADD `enforce` integer;--> statement-breakpoint
ALTER TABLE `prompt_settings` ADD `scope` text(16);--> statement-breakpoint
ALTER TABLE `prompt_settings` ADD `override` text(16);--> statement-breakpoint
ALTER TABLE `prompt_settings` ADD `enforce` integer;
--> statement-breakpoint
-- Map the existing publishing flags onto the new fields so behaviour does not
-- change: is_system rows and hooks flagged metadata.inheritable are shared.
UPDATE `connections` SET `scope` = 'shared', `override` = 'none' WHERE `is_system` = 1 AND `scope` IS NULL;
--> statement-breakpoint
UPDATE `actions` SET `scope` = 'shared', `override` = 'none' WHERE `is_system` = 1 AND `scope` IS NULL;
--> statement-breakpoint
UPDATE `resource_servers` SET `scope` = 'shared', `override` = 'none' WHERE `is_system` = 1 AND `scope` IS NULL;
--> statement-breakpoint
UPDATE `hooks` SET `scope` = 'shared', `override` = 'none' WHERE `scope` IS NULL AND `metadata` LIKE '%"inheritable":true%';
