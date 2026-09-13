// Server-side environment. Every value here is injected by the NixOS module —
// nothing is read from a .env file, and nothing has a hardcoded fallback that
// would let a misconfigured container boot and look healthy.
//
// Where each one comes from:
//   DATABASE_URL      — stacks/app-db, generated per-app env file
//   LITELLM_BASE_URL  — stacks/apps/apps.nix, `litellm.enable = true`
//   LITELLM_API_KEY   — stacks/daedalus/daedalus.nix, mkSecretRender extracting
//                       just the master key out of litellm's env.sops
//
// Getters, not fields: the check has to happen when a value is USED, not when
// this module is first imported, or a container missing a variable one page
// needs would refuse to serve the other twenty.
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
  get databaseUrl() {
    return required('DATABASE_URL')
  },
  get litellmBaseUrl() {
    return required('LITELLM_BASE_URL')
  },
  /**
   * The gateway's master key. Throwing when it is missing is the point: read
   * raw it produced a `Bearer ` with nothing after it, which LiteLLM answers
   * with 401s that this app's own `getJson` turns into nulls — a tab of
   * zeroes and dashes that looks like a quiet day rather than a broken one.
   */
  get litellmApiKey() {
    return required('LITELLM_API_KEY')
  },
}
