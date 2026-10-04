-- Build placeholders are gone: the box passes no build secrets, and a repo that
-- needs a build-time value declares a dummy one in its own railpack.json.
ALTER TABLE "apps" DROP COLUMN "build_env_placeholders";
