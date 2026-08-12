// The registry schema version, as one exported constant.
//
// This number used to exist as four independent literals — the export writer,
// the file renderer's type, declarations.nix's assertion, and a reader that
// hardcoded it into its own return value. The TS side now imports it from
// here; the nix side's single copy lives in stacks/apps/registry-lib.nix,
// whose assertion is what keeps the two ecosystems honest with each other at
// build time.
//
// ONE version, no compatibility range: reader and writer live in the same
// repo with one operator, so a bump is a single coordinated commit (this
// constant, the nix reader, and a regenerated apps.json together).
//
// v2 added `deploy: { enable }` per entry — the freeze switch.
export const REGISTRY_SCHEMA_VERSION = 2
