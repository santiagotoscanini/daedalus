import { join } from 'node:path'
import { nullable, num, obj, optional, str } from '../decode'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /export/site.json — the box's identity. The client-visible half already
// arrives as VITE_ env (src/lib/site.ts); this reader is for the server-only
// facts a page renders: mail, the operator, and since Settings › General, the
// rest of what the box calls itself.

export type MailIdentity = { sender: string; alertTo: string }

/** The release, as platform/export.nix states it (`site.nixos`). */
export type NixosFacts = {
  /** `25.11.20260630.b6018f8` */
  version: string
  /** `25.11`; the channel is `nixos-<release>`. */
  release: string
  codeName: string
  /** The nixpkgs commit the flake locked. Null when nixpkgs was not a git input. */
  revision: string | null
  /** This generation's kernel, which a switch without a reboot can leave ahead of the running one. */
  kernel: string
  stateVersion: string
}

export type SiteIdentity = {
  hostname: string
  baseDomain: string
  wanHost: string
  lanIp: string
  stateRoot: string
  timezone: string
  nixosVersion: string | null
  /** Null until the export carries it. */
  nixos: NixosFacts | null
  network: { interface: string | null; gateway: string | null }
  owner: string
  operator: { user: string; group: string; uid: number | null }
  registryUrl: string
  grafanaUrl: string
  mail: MailIdentity
}

const shape = obj({
  hostname: optional(str, ''),
  baseDomain: optional(str, ''),
  wanHost: optional(str, ''),
  lanIp: optional(str, ''),
  stateRoot: optional(str, ''),
  timezone: optional(str, ''),
  nixosVersion: optional(nullable(str), null),
  nixos: optional(
    nullable(
      obj({
        version: optional(str, ''),
        release: optional(str, ''),
        codeName: optional(str, ''),
        revision: optional(nullable(str), null),
        kernel: optional(str, ''),
        stateVersion: optional(str, ''),
      }),
    ),
    null,
  ),
  network: optional(
    obj({ interface: optional(nullable(str), null), gateway: optional(nullable(str), null) }),
    { interface: null, gateway: null },
  ),
  owner: optional(str, ''),
  operator: optional(
    obj({ user: optional(str, ''), group: optional(str, ''), uid: optional(nullable(num), null) }),
    { user: '', group: '', uid: null },
  ),
  registryUrl: optional(str, ''),
  grafanaUrl: optional(str, ''),
  mail: optional(obj({ sender: optional(str, ''), alertTo: optional(str, '') }), {
    sender: '',
    alertTo: '',
  }),
})

export const NO_SITE: SiteIdentity = {
  hostname: '',
  baseDomain: '',
  wanHost: '',
  lanIp: '',
  stateRoot: '',
  timezone: '',
  nixosVersion: null,
  nixos: null,
  network: { interface: null, gateway: null },
  owner: '',
  operator: { user: '', group: '', uid: null },
  registryUrl: '',
  grafanaUrl: '',
  mail: { sender: '', alertTo: '' },
}

/**
 * The identity export whole, with the envelope's `revision` — the commit the
 * running generation was built from — surfaced beside it, since that is the
 * one envelope field a page renders as a fact of its own.
 */
export async function siteIdentity(): Promise<
  SnapshotResult<SiteIdentity> & { revision: string | null }
> {
  const path = join(process.env.EXPORT_DIR ?? '/export', 'site.json')
  const r = await readSnapshot({ path, decoder: shape, fallback: NO_SITE, acceptVersions: [1] })
  return { ...r, revision: await exportRevision(path) }
}

/** The one mail identity every sender on the box uses. Null = export missing. */
export async function siteMail(): Promise<MailIdentity | null> {
  const r = await siteIdentity()
  if (!r.available || r.data.mail.sender === '') return null
  return r.data.mail
}

// The envelope decoder in snapshot.ts keeps `revision` to itself (no other
// reader wants it), so it is read back here rather than widening the
// SnapshotResult every consumer sees.
async function exportRevision(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    const doc: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (doc === null || typeof doc !== 'object') return null
    const rev = (doc as Record<string, unknown>).revision
    return typeof rev === 'string' && rev !== '' ? rev : null
  } catch {
    return null
  }
}
