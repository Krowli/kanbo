CREATE TABLE "issue_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"content" text NOT NULL,
	"author_kind" text DEFAULT 'user' NOT NULL,
	"author_id" text,
	"source_chat_session_id" text,
	"agent_activity_id" text,
	"dedupe_key" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_field_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"field" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"actor_id" text,
	"source_chat_session_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"due_date" bigint,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"source_issue_id" text NOT NULL,
	"target_issue_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"launched_by_kind" text DEFAULT 'user' NOT NULL,
	"launched_by_id" text,
	"agent_id" text,
	"agent_name" text NOT NULL,
	"host" text,
	"execution_mode" text DEFAULT 'worktree' NOT NULL,
	"branch" text,
	"worktree_path" text,
	"state" text DEFAULT 'running' NOT NULL,
	"chat_session_id" text,
	"started_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"ended_at" bigint,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"category" text DEFAULT 'unstarted' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number" integer NOT NULL,
	"status_id" text,
	"milestone_id" text,
	"parent_issue_id" text,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'none' NOT NULL,
	"labels" text DEFAULT '[]' NOT NULL,
	"assignee_kind" text,
	"assignee_id" text,
	"due_date" bigint,
	"created_by_kind" text DEFAULT 'user' NOT NULL,
	"created_by_id" text DEFAULT '__self__' NOT NULL,
	"source_chat_session_id" text,
	"delegate_agent_id" text,
	"delegate_provider_target_id" text,
	"context_refs" text DEFAULT '[]' NOT NULL,
	"status_line" text,
	"waiting_for" text,
	"execution_mode" text DEFAULT 'worktree' NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kanban_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_field_changes" ADD CONSTRAINT "issue_field_changes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_runs" ADD CONSTRAINT "issue_runs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_id_issue_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."issue_statuses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_milestone_id_issue_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."issue_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_comments_issue_id_idx" ON "issue_comments" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comments_issue_dedupe_idx" ON "issue_comments" USING btree ("issue_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "issue_field_changes_issue_id_idx" ON "issue_field_changes" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_milestones_workspace_id_idx" ON "issue_milestones" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "issue_relations_source_issue_id_idx" ON "issue_relations" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX "issue_relations_target_issue_id_idx" ON "issue_relations" USING btree ("target_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_relations_pair_type_unique" ON "issue_relations" USING btree ("source_issue_id","target_issue_id","type");--> statement-breakpoint
CREATE INDEX "issue_runs_issue_id_idx" ON "issue_runs" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_runs_issue_state_idx" ON "issue_runs" USING btree ("issue_id","state");--> statement-breakpoint
CREATE INDEX "issue_runs_chat_session_idx" ON "issue_runs" USING btree ("chat_session_id");--> statement-breakpoint
CREATE INDEX "issue_statuses_workspace_id_idx" ON "issue_statuses" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_statuses_workspace_name_unique" ON "issue_statuses" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "issues_workspace_id_idx" ON "issues" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_workspace_number_unique" ON "issues" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "issues_status_id_idx" ON "issues" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "issues_milestone_id_idx" ON "issues" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "issues_parent_issue_id_idx" ON "issues" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE INDEX "issues_delegate_agent_id_idx" ON "issues" USING btree ("delegate_agent_id");--> statement-breakpoint
CREATE INDEX "issues_delegate_provider_target_id_idx" ON "issues" USING btree ("delegate_provider_target_id");--> statement-breakpoint
INSERT INTO "kanban_meta" ("key", "revision") VALUES ('board', 0) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "kanban_meta" ("key", "revision") VALUES ('schema_epoch', 1) ON CONFLICT ("key") DO NOTHING;
