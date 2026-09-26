CREATE TABLE `issue_pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_pull_requests_issue_pr_unique` ON `issue_pull_requests` (`issue_id`,`owner`,`repo`,`number`);--> statement-breakpoint
CREATE INDEX `issue_pull_requests_pr_idx` ON `issue_pull_requests` (`owner`,`repo`,`number`);