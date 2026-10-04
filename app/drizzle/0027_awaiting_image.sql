ALTER TABLE "apps" DROP CONSTRAINT "apps_stage_check";--> statement-breakpoint
ALTER TABLE "apps" ALTER COLUMN "stage" SET DEFAULT 'lab';--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "awaiting_image" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A `declared` app (the rung this removes) becomes a new app that awaits its
-- first image, at the rung a promotion would have offered first. One whose
-- image already exists is set up by the next scheduler tick (lib/apps/setup.ts).
UPDATE "apps" SET "awaiting_image" = true, "stage" = 'lab' WHERE "stage" = 'declared';--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_stage_check" CHECK ("apps"."stage" IN ('off', 'lab', 'live'));