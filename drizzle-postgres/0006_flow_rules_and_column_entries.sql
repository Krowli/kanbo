ALTER TABLE "issue_statuses" ADD COLUMN "allowed_from" text;--> statement-breakpoint
ALTER TABLE "issue_statuses" ADD COLUMN "wip_limit" integer;--> statement-breakpoint
CREATE INDEX "issue_field_changes_field_created_at_idx" ON "issue_field_changes" USING btree ("field","created_at");