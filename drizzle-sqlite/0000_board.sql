CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`content` text NOT NULL,
	`author_kind` text DEFAULT 'user' NOT NULL,
	`author_id` text,
	`source_chat_session_id` text,
	`agent_activity_id` text,
	`dedupe_key` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_id_idx` ON `issue_comments` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_comments_issue_dedupe_idx` ON `issue_comments` (`issue_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `issue_field_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`actor_kind` text DEFAULT 'user' NOT NULL,
	`actor_id` text,
	`source_chat_session_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_field_changes_issue_id_idx` ON `issue_field_changes` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`due_date` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_milestones_workspace_id_idx` ON `issue_milestones` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `issue_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_issue_id` text NOT NULL,
	`target_issue_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_relations_source_issue_id_idx` ON `issue_relations` (`source_issue_id`);--> statement-breakpoint
CREATE INDEX `issue_relations_target_issue_id_idx` ON `issue_relations` (`target_issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_relations_pair_type_unique` ON `issue_relations` (`source_issue_id`,`target_issue_id`,`type`);--> statement-breakpoint
CREATE TABLE `issue_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`launched_by_kind` text DEFAULT 'user' NOT NULL,
	`launched_by_id` text,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`host` text,
	`execution_mode` text DEFAULT 'worktree' NOT NULL,
	`branch` text,
	`worktree_path` text,
	`state` text DEFAULT 'running' NOT NULL,
	`chat_session_id` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_runs_issue_id_idx` ON `issue_runs` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_runs_issue_state_idx` ON `issue_runs` (`issue_id`,`state`);--> statement-breakpoint
CREATE INDEX `issue_runs_chat_session_idx` ON `issue_runs` (`chat_session_id`);--> statement-breakpoint
CREATE TABLE `issue_statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text,
	`category` text DEFAULT 'unstarted' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issue_statuses_workspace_id_idx` ON `issue_statuses` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_statuses_workspace_name_unique` ON `issue_statuses` (`workspace_id`,`name`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`number` integer NOT NULL,
	`status_id` text,
	`milestone_id` text,
	`parent_issue_id` text,
	`title` text NOT NULL,
	`description` text,
	`priority` text DEFAULT 'none' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`assignee_kind` text,
	`assignee_id` text,
	`due_date` integer,
	`created_by_kind` text DEFAULT 'user' NOT NULL,
	`created_by_id` text DEFAULT '__self__' NOT NULL,
	`source_chat_session_id` text,
	`delegate_agent_id` text,
	`delegate_provider_target_id` text,
	`context_refs` text DEFAULT '[]' NOT NULL,
	`status_line` text,
	`waiting_for` text,
	`execution_mode` text DEFAULT 'worktree' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`status_id`) REFERENCES `issue_statuses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`milestone_id`) REFERENCES `issue_milestones`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issues_workspace_id_idx` ON `issues` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_workspace_number_unique` ON `issues` (`workspace_id`,`number`);--> statement-breakpoint
CREATE INDEX `issues_status_id_idx` ON `issues` (`status_id`);--> statement-breakpoint
CREATE INDEX `issues_milestone_id_idx` ON `issues` (`milestone_id`);--> statement-breakpoint
CREATE INDEX `issues_parent_issue_id_idx` ON `issues` (`parent_issue_id`);--> statement-breakpoint
CREATE INDEX `issues_delegate_agent_id_idx` ON `issues` (`delegate_agent_id`);--> statement-breakpoint
CREATE INDEX `issues_delegate_provider_target_id_idx` ON `issues` (`delegate_provider_target_id`);--> statement-breakpoint
CREATE TABLE `kanban_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `kanban_meta` (`key`, `revision`) VALUES ('board', 0);--> statement-breakpoint
INSERT OR IGNORE INTO `kanban_meta` (`key`, `revision`) VALUES ('schema_epoch', 1);
