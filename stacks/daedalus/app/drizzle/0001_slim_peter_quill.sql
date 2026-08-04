CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"digest" text NOT NULL,
	"previous_digest" text,
	"result" text NOT NULL,
	"http_code" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"revision" text,
	"source_url" text,
	"image_created_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_app_digest_started_idx" ON "deployments" USING btree ("app_id","digest","started_at");