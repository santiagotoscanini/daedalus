ALTER TABLE "nodes" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "nodes" DROP COLUMN "last_hello";--> statement-breakpoint
ALTER TABLE "nodes" DROP COLUMN "update_check_requested";--> statement-breakpoint
ALTER TABLE "nodes" DROP COLUMN "claude_update_requested";--> statement-breakpoint
ALTER TABLE "nodes" DROP COLUMN "claude_restart_requested";--> statement-breakpoint
ALTER TABLE "nodes" DROP COLUMN "token";