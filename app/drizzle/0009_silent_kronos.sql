CREATE TABLE "builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"lane" text DEFAULT 'main' NOT NULL,
	"pr_number" integer,
	"sha" text NOT NULL,
	"strategy" text NOT NULL,
	"resolved_strategy" text,
	"publish" text DEFAULT 'live' NOT NULL,
	"requested_by" text NOT NULL,
	"actor" text,
	"delivery_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"phase" text,
	"error" text,
	"started_at" timestamp with time zone,
	"detected" jsonb,
	"warnings" jsonb,
	"checks" jsonb,
	"timings" jsonb,
	"check_run_id" bigint,
	"deployment_id" bigint,
	"reported" boolean DEFAULT false NOT NULL,
	"digest" text,
	"image_ref" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "github_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "build_strategy" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "build_publish" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "build_env_placeholders" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "railpack_env" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "builds" ADD CONSTRAINT "builds_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builds_app_created_idx" ON "builds" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "builds_one_queued_per_lane" ON "builds" USING btree ("app_id","lane") WHERE "builds"."state" = 'queued';