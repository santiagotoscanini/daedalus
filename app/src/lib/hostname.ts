// Where an app is published.
//
// The rule is one DNS label under the base domain, and it comes from
// infrastructure rather than taste. traefik serves a single entrypoint-level
// ACME cert — `main=<baseDomain>` + `sans=*.<baseDomain>` (nix/modules/traefik) —
// and a wildcard matches exactly one label. `a.b.example.org` would resolve,
// route, and then serve a certificate no browser accepts. The Cloudflare
// tunnel's CNAMEs and pi-hole's short-circuit make the same assumption.
//
// nix/modules/apps/apps.nix asserts this too, so a bad value cannot reach a running
// system either way. It is checked HERE as well because the nix assertion
// fires during Apply — after the commit, mid-rebuild — and recovering from
// that is a revert. Rejecting it at the edit is the difference between a red
// input box and a failed deploy.

// The domain is the box's, known only at run time, so the two functions that
// need it take the `Site`: `ctx.site` / `readSite()` on the server,
// `useSite()` in a component.
import type { Site } from './site'

/** One label: letters, digits, inner hyphens. Mirrors `hostnameRe` in apps.nix. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * `app-<name>` is a container name and the left label of a hostname; 63 is the
 * DNS limit and the shorter of the two ceilings.
 */
const APP_NAME_MAX = 59

/**
 * Is this string, exactly as it arrived, an app name?
 *
 * The shape half of `appNameError` below, without the creation-time questions
 * (is the name taken, is the label reserved) — so a request naming an app that
 * already exists is checked against the same rule the app was created under.
 * Use this, not a looser local regex: `/^[a-z0-9][a-z0-9-]{0,62}$/` accepts a
 * trailing hyphen and 63 characters that creation refuses, and the one string
 * that is the container name, the DNS label, the postgres role and the
 * systemd unit name must have one definition.
 *
 * Nothing is trimmed or lowercased here. `appNameError` does that because it
 * reads a repository name a person just picked; a name arriving over the wire
 * is either the app's name or it is not.
 */
export function isAppName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= APP_NAME_MAX && LABEL.test(v)
}

/**
 * Labels under the base domain that an app may never claim, each with why (the
 * rest of a sentence that starts with the label): nix's `fleet.reservedLabels`,
 * read from /export/publishing.json (`publishingFacts().reservedLabels`). The
 * engine reserves `hooks`, the GitHub App's webhook; a host adds the names it
 * publishes outside the box, which no `taken` list holds. Nix asserts them; the
 * edit is where they should be caught.
 */
export type ReservedLabels = Readonly<Record<string, string>>

/**
 * Is this usable as an app's key?
 *
 * The key is the most load-bearing string on the platform: it is the container
 * name `app-<name>`, the default hostname, the postgres role and database, the
 * GitHub repo, the systemd unit names, and the directory under
 * <stateRoot>/apps. Nothing renames it — a rename is a new app
 * plus a migration — so it is worth being strict at the one moment it is
 * chosen.
 *
 * @param taken app names already in the registry or declared by hand in Nix.
 * @param reserved the box's reserved labels (`ReservedLabels`).
 */
export function appNameError(
  name: string,
  taken: readonly string[] = [],
  reserved: ReservedLabels = {},
): string | null {
  const n = name.trim().toLowerCase()
  if (n === '') return 'pick a repository first.'
  if (taken.includes(n)) return `${n} is already an app on this box.`
  if (!LABEL.test(n)) {
    return 'may use lowercase letters, digits and inner hyphens only. It becomes a DNS label, a container name and a postgres role.'
  }
  // The name derives the default hostname, so a reserved label is reserved here too.
  const why = Object.hasOwn(reserved, n) ? reserved[n] : undefined
  if (why) return `${n} ${why}`
  // Last, so the message is about the length rather than the syntax — and it
  // is the one part of `isAppName` worth its own sentence.
  if (n.length > APP_NAME_MAX) {
    return 'too long. `app-<name>` has to fit in a 63-character DNS label.'
  }
  return null
}

/**
 * @param taken hostnames already published on the box, this app's own
 *        excluded. A collision is a hard failure in Nix — fleet.traefikRoutes
 *        refuses two routers on one entrypoint+host, since traefik's pick
 *        between identical rules is nondeterministic — and that failure lands
 *        mid-Apply, after the commit.
 * @param reserved the box's reserved labels (`ReservedLabels`).
 * @returns an operator-facing reason, or null when the hostname is usable.
 */
export function hostnameError(
  site: Site,
  value: string,
  taken: readonly string[] = [],
  reserved: ReservedLabels = {},
): string | null {
  const domain = site.baseDomain
  const h = value.trim().toLowerCase()
  if (h === '') return null // empty means "use the default"

  if (taken.includes(h)) {
    return `${h} is already published by something else on this box. Two traefik routers on one host is a build failure, not a race.`
  }

  if (!h.endsWith(`.${domain}`)) {
    return `must end in .${domain}, the only domain with a wildcard cert, a tunnel and DNS on this box.`
  }

  const label = h.slice(0, -(domain.length + 1))
  if (label === '') return `needs a name in front of .${domain}.`
  if (label.includes('.')) {
    return `only one level under ${domain}. The wildcard cert matches a single label, so "${h}" would serve the wrong certificate.`
  }
  if (!LABEL.test(label)) {
    return 'may use lowercase letters, digits and inner hyphens only.'
  }
  // Checked after the shape rules so the message is about the name, not the
  // syntax. `taken` cannot cover these: they are published outside the box, or
  // by a raw router rather than a webApp.
  const why = Object.hasOwn(reserved, label) ? reserved[label] : undefined
  if (why) return `${label} ${why} Pick another name.`
  return null
}

/** What Nix will publish: the override, or the derived default. */
export function effectiveHostname(site: Site, name: string, hostname: string | null): string {
  return hostname ?? `${name}.${site.baseDomain}`
}
