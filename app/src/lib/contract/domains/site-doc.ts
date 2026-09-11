import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SiteDocument } from '../../../core/site/file'
import { arrayOf, bool, decode, literal, nullable, num, obj, optional, str } from '../decode'

// /site/site.json — the committed document, read from the site directory
// mounted read-only into the container. Since Phase 5 this is THE source of
// the site constants nix builds with, and the thing the settings page edits
// against. The mount holds only the directory, never the repository root.

const shape = obj({
  schemaVersion: literal('1'),
  identity: obj({
    hostname: str,
    baseDomain: str,
    // Optional: a site.json written before the control plane's address was
    // part of it still reads, and nix keeps the address stacks/daedalus names.
    controlPlane: optional(str, ''),
    controlPlanePrevious: optional(nullable(str), null),
    timezone: str,
    owner: str,
    operator: obj({ user: str, group: str }),
  }),
  network: obj({
    lanIp: str,
    interface: nullable(str),
    gateway: nullable(str),
    wanHost: str,
    ddns: obj({ host: str, interval: str }),
    dhcp: obj({ active: bool, router: str, start: str, end: str, leaseTime: str }),
    dnsUpstreams: arrayOf(str),
  }),
  mail: obj({ sender: str, alertTo: str }),
  cloudflare: obj({ accountId: str, zoneId: str, tunnelId: str }),
  // The GitHub App's public half. Last, and it must stay last: `obj` copies
  // only the keys named here, so a key missing from this shape is dropped by
  // the next write, and the renderer puts this block after everything else.
  // A file from before the App reads as none, and renders without it.
  github: optional(
    obj({
      app: nullable(
        obj({
          id: num,
          slug: str,
          clientId: str,
          htmlUrl: str,
          owner: str,
          ownerId: num,
        }),
      ),
    }),
    { app: null },
  ),
})

// `schemaVersion` is a number in the document; `literal` is string-only, so it
// is stringified before decoding and the version restored after.
export function decodeSiteDocument(raw: unknown): SiteDocument {
  const withVersion =
    raw !== null && typeof raw === 'object'
      ? {
          ...(raw as Record<string, unknown>),
          schemaVersion: String((raw as Record<string, unknown>).schemaVersion),
        }
      : raw
  const d = decode(shape, withVersion)
  return { ...d, schemaVersion: 1 }
}

export type CommittedSite =
  | { present: true; doc: SiteDocument; bytes: string }
  | { present: false; error: string | null }

/** The committed site.json, or the reason there is none. */
export async function readCommittedSite(): Promise<CommittedSite> {
  const path = join(process.env.SITE_PATH ?? '/site', 'site.json')
  let bytes: string
  try {
    bytes = await readFile(path, 'utf8')
  } catch {
    return { present: false, error: null }
  }
  try {
    return { present: true, doc: decodeSiteDocument(JSON.parse(bytes)), bytes }
  } catch (e) {
    return { present: false, error: e instanceof Error ? e.message : String(e) }
  }
}
