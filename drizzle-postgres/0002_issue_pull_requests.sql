CREATE TABLE "issue_pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"created_by_kind" text NOT NULL,
	"created_by_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now())::bigint) NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_pull_requests" ADD CONSTRAINT "issue_pull_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_pull_requests_issue_pr_unique" ON "issue_pull_requests" USING btree ("issue_id","owner","repo","number");--> statement-breakpoint
CREATE INDEX "issue_pull_requests_pr_idx" ON "issue_pull_requests" USING btree ("owner","repo","number");