CREATE TABLE "app_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"stage" text DEFAULT 'lab' NOT NULL,
	"managed_in_nix" boolean DEFAULT false NOT NULL,
	"source_mode" text DEFAULT 'registry' NOT NULL,
	"image" text,
	"postgres" boolean DEFAULT false NOT NULL,
	"storage" boolean DEFAULT false NOT NULL,
	"litellm" boolean DEFAULT false NOT NULL,
	"prometheus" boolean DEFAULT false NOT NULL,
	"operator_secrets" boolean DEFAULT false NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"auth_health_path" text,
	"auth_isolated" boolean DEFAULT false NOT NULL,
	"auth_allowed_groups" text[],
	"auth_bypass_rule" text,
	"egress_container" text,
	"egress_host_port" integer,
	"homepage_description" text DEFAULT '' NOT NULL,
	"homepage_icon" text DEFAULT 'mdi-cube-outline-#94a3b8' NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_env_vars" ADD CONSTRAINT "app_env_vars_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_env_vars_app_key_idx" ON "app_env_vars" USING btree ("app_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_name_idx" ON "apps" USING btree ("name");