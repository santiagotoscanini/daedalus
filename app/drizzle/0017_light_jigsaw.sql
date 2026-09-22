ALTER TABLE "nodes" ADD COLUMN "claude_restart_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "policy" jsonb DEFAULT '{}'::jsonb NOT NULL;