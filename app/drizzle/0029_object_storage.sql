ALTER TABLE "apps" ADD COLUMN "object_storage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Every app that kept files on its data dir gets a bucket: the disk primitive is
-- being retired in favour of object storage, and the apps move their files.
UPDATE "apps" SET "object_storage" = "storage";
