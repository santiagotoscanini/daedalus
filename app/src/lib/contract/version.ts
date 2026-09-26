// The registry schema version, as one exported constant.
//
// Every TS reader and writer imports it from here; the nix side's single copy
// is `acceptedSchemaVersions` in nix/platform/lib/registry-lib.nix, and the
// assertion in nix/modules/apps/declarations.nix that reads it is what keeps
// the two ecosystems honest with each other at build time.
//
// ONE version, no compatibility range: reader and writer live in the same
// repo with one operator, so a bump is a single coordinated commit (this
// constant, the nix reader, and a regenerated apps.json together).
//
// v2 added `deploy: { enable }` per entry — the freeze switch.
export const REGISTRY_SCHEMA_VERSION = 2
