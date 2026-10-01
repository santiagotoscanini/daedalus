ALTER TABLE "apps" ALTER COLUMN "stage" SET DEFAULT 'declared';--> statement-breakpoint
CREATE INDEX "builds_open_idx" ON "builds" USING btree ("state","created_at") WHERE "builds"."state" IN ('queued', 'cloning', 'detecting', 'checking', 'building', 'publishing');--> statement-breakpoint
CREATE INDEX "builds_unreported_idx" ON "builds" USING btree ("updated_at") WHERE "builds"."reported" = false;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_stage_check" CHECK ("apps"."stage" IN ('declared', 'off', 'lab', 'live'));--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_source_mode_check" CHECK ("apps"."source_mode" IN ('registry', 'local'));--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_auth_mode_check" CHECK ("apps"."auth_mode" IN ('none', 'proxy', 'native'));--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_build_strategy_check" CHECK ("apps"."build_strategy" IN ('auto', 'railpack', 'dockerfile'));--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_build_publish_check" CHECK ("apps"."build_publish" IN ('live', 'candidate'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_lane_check" CHECK ("builds"."lane" IN ('main', 'pr'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_strategy_check" CHECK ("builds"."strategy" IN ('auto', 'railpack', 'dockerfile'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_resolved_strategy_check" CHECK ("builds"."resolved_strategy" IN ('railpack', 'dockerfile'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_publish_check" CHECK ("builds"."publish" IN ('live', 'candidate'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_requested_by_check" CHECK ("builds"."requested_by" IN ('webhook', 'sweep', 'operator'));--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_state_check" CHECK ("builds"."state" IN ('queued', 'cloning', 'detecting', 'checking', 'building', 'publishing', 'succeeded', 'failed', 'cancelled', 'superseded'));--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_result_check" CHECK ("deployments"."result" IN ('ok', 'failed'));--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_scope_check" CHECK ("mcp_tokens"."scope" IN ('read', 'write'));--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_state_check" CHECK ("nodes"."state" IN ('approved', 'revoked'));