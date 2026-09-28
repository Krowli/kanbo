ALTER TABLE "issue_comments" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_field_changes" ADD COLUMN "seq" bigserial NOT NULL;