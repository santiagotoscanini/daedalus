CREATE TABLE "app_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"schedule" text NOT NULL,
	"command" jsonb NOT NULL,
	"timeout_sec" integer DEFAULT 900 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_tasks" ADD CONSTRAINT "app_tasks_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_tasks_app_task_idx" ON "app_tasks" USING btree ("app_id","task_id");