// The registry schema version, as one exported constant.
//
// This number used to exist as four independent literals — the export writer,
// the file renderer's type, declarations.nix's assertion, and a reader that
// hardcoded it into its own return value. The TS side now imports it from
// here; the nix side's single copy lives in stacks/apps (the declarations
// reader), whose assertion is what keeps the two ecosystems honest with each
// other at build time.
export const REGISTRY_SCHEMA_VERSION = 1
