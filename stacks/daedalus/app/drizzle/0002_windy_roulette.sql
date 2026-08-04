ALTER TABLE "apps" ADD COLUMN "limit_cpus" real;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "limit_memory_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "limit_pids" integer;