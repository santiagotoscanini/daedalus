// Server-side environment. Every value here is injected by the NixOS module —
// nothing is read from a .env file, and nothing has a hardcoded fallback that
// would let a misconfigured container boot and look healthy.
//
// Where each one comes from:
//   APP_*             — stacks/apps/apps.nix, from the fleet.apps entry
//   DATABASE_URL      — stacks/app-db, generated per-app env file
//   LITELLM_BASE_URL  — stacks/apps/apps.nix, `litellm.enable = true`
//   LITELLM_API_KEY   — stacks/daedalus/daedalus.nix, mkSecretRender extracting
//                       just the master key out of litellm's env.sops
//
// This module must never be imported from a client component: `process` does
// not exist in the browser, and LITELLM_API_KEY must not cross that boundary.

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. It is injected by the NixOS module — check ` +
        `stacks/daedalus/daedalus.nix and the container's env files.`,
    )
  }
  return value
}

export const env = {
  appName: process.env.APP_NAME ?? 'daedalus',
  hostname: process.env.APP_HOSTNAME ?? 'localhost',
  publicUrl: process.env.APP_PUBLIC_URL ?? 'http://localhost:3000',

  get databaseUrl() {
    return required('DATABASE_URL')
  },
  get litellmBaseUrl() {
    return required('LITELLM_BASE_URL')
  },
  get litellmApiKey() {
    return required('LITELLM_API_KEY')
  },
}
