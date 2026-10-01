ALTER TABLE "nodes" ADD COLUMN "policy_changed_by" text;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "policy_changed_at" timestamp with time zone;