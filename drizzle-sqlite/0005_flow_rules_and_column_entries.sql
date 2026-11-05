ALTER TABLE `issue_statuses` ADD `allowed_from` text;--> statement-breakpoint
ALTER TABLE `issue_statuses` ADD `wip_limit` integer;--> statement-breakpoint
CREATE INDEX `issue_field_changes_field_created_at_idx` ON `issue_field_changes` (`field`,`created_at`);