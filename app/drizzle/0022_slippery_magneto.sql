CREATE TABLE "enroll_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"client_id" integer NOT NULL,
	"challenge" text NOT NULL,
	"controller_pin" text NOT NULL,
	"controller_address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_tunnels" (
	"node_id" text PRIMARY KEY NOT NULL,
	"client_id" integer NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_tunnels_client_id_unique" UNIQUE("client_id")
);
