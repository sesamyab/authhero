CREATE TABLE `tenant_member_requests` (
	`tenant_id` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`error` text,
	`notified_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`finished_at` text,
	PRIMARY KEY(`tenant_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `tenant_member_requests_status_idx` ON `tenant_member_requests` (`tenant_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `tenant_member_requests_finished_idx` ON `tenant_member_requests` (`finished_at`);