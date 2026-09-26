import type { SecretName } from './env'

// Per-service API keys (`DASH_*`), rendered to /run/daedalus-dashboard/env by
// daedalus-dashboard-keys.service (nix/stacks/daedalus/daedalus.nix).
//
// Its own module, apart from lib/format.ts, because it reads process.env: kept
// out of lib/, the formatters stay importable from a component without pulling
// a secrets accessor into a client chunk.
export const key = (name: SecretName): string => process.env[`DASH_${name}`] ?? ''
