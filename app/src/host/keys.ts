import type { SecretName } from './env'

// Per-service API keys, rendered to /run/daedalus-dashboard/env by nix.
//
// Its own module — the ONE process.env read the formatter file used to carry,
// which was the only thing keeping every pure string formatter server-side.
// Splitting it is what lets lib/format.ts be imported from components without
// dragging a secrets accessor into a client chunk. That `process.env` is also
// why the accessor lives here under host/ and the formatters stayed in lib/.
export const key = (name: SecretName): string => process.env[`DASH_${name}`] ?? ''
