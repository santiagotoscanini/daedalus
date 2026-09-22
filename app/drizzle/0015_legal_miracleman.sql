CREATE TABLE "nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"arch" text NOT NULL,
	"agent_version" text NOT NULL,
	"mac" text,
	"lan_ip" text,
	"status_port" integer,
	"last_hello" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "nodes_public_key_unique" UNIQUE("public_key")
);
