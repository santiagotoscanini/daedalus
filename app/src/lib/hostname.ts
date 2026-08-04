// Where an app is published.
//
// The rule is one DNS label under the base domain, and it comes from
// infrastructure rather than taste. traefik serves a single entrypoint-level
// ACME cert — `main=toscanini.me` + `sans=*.toscanini.me` (stacks/traefik) —
// and a wildcard matches exactly one label. `a.b.toscanini.me` would resolve,
// route, and then serve a certificate no browser accepts. The Cloudflare
// tunnel's CNAMEs and pi-hole's short-circuit make the same assumption.
//
// stacks/apps/apps.nix asserts this too, so a bad value cannot reach a running
// system either way. It is checked HERE as well because the nix assertion
// fires during Apply — after the commit, mid-rebuild — and recovering from
// that is a revert. Rejecting it at the edit is the difference between a red
// input box and a failed deploy.

export const BASE_DOMAIN = 'toscanini.me'

/** One label: letters, digits, inner hyphens. Mirrors `hostnameRe` in apps.nix. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * @param taken hostnames already published on the box, this app's own
 *        excluded. A collision is a hard failure in Nix — fleet.traefikRoutes
 *        refuses two routers on one entrypoint+host, since traefik's pick
 *        between identical rules is nondeterministic — and that failure lands
 *        mid-Apply, after the commit.
 * @returns an operator-facing reason, or null when the hostname is usable.
 */
export function hostnameError(value: string, taken: readonly string[] = []): string | null {
  const h = value.trim().toLowerCase()
  if (h === '') return null // empty means "use the default"

  if (taken.includes(h)) {
    return `${h} is already published by something else on this box — two traefik routers on one host is a build failure, not a race.`
  }

  if (!h.endsWith(`.${BASE_DOMAIN}`)) {
    return `must end in .${BASE_DOMAIN} — it is the only domain with a wildcard cert, a tunnel and DNS on this box.`
  }

  const label = h.slice(0, -(BASE_DOMAIN.length + 1))
  if (label === '') return `needs a name in front of .${BASE_DOMAIN}.`
  if (label.includes('.')) {
    return `only one level under ${BASE_DOMAIN} — the wildcard cert matches a single label, so "${h}" would serve the wrong certificate.`
  }
  if (!LABEL.test(label)) {
    return 'may use lowercase letters, digits and inner hyphens only.'
  }
  return null
}

/** What Nix will publish: the override, or the derived default. */
export function effectiveHostname(name: string, hostname: string | null): string {
  return hostname ?? `${name}.${BASE_DOMAIN}`
}
