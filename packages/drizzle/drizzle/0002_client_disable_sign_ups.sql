ALTER TABLE `clients` ADD `disable_sign_ups` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `hide_sign_up_disabled_error` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `clients` SET `disable_sign_ups` = 1, `client_metadata` = json_remove(`client_metadata`, '$.disable_sign_ups') WHERE json_extract(`client_metadata`, '$.disable_sign_ups') = 'true';--> statement-breakpoint
UPDATE `clients` SET `client_metadata` = json_remove(`client_metadata`, '$.disable_sign_ups') WHERE json_extract(`client_metadata`, '$.disable_sign_ups') IS NOT NULL;
