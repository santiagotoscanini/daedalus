import { age } from '../../../lib/dns-zone'
import { localDay } from '../../../lib/format'
import { getJson } from '../../../lib/http'
import type { Registration } from './dns'

// Network › DNS, the registration: the domain's registry record over RDAP —
// the failure nothing on this box would notice, because every hostname,
// certificate, tunnel route and OIDC redirect URI is a leaf of this one name.

/**
 * The `.me` registry's RDAP service.
 *
 * Hardcoded rather than discovered, and that is a finding rather than a
 * shortcut: IANA's bootstrap at data.iana.org/rdap/dns.json carries no service
 * entry for `me`, so rdap.org, rdap.net and rdap.iana.org all answer 404 for
 * this domain (all three checked). Identity Digital runs the registry and
 * serves it here. A second domain under a different TLD would need the
 * bootstrap file and this as its fallback.
 */
const RDAP = 'https://rdap.identitydigital.services/rdap/domain'

type RdapEntity = { roles?: string[]; vcardArray?: unknown[]; links?: { href?: string }[] }
type RdapDomain = {
  events?: { eventAction?: string; eventDate?: string }[]
  status?: string[]
  entities?: RdapEntity[]
  nameservers?: { ldhName?: string }[]
  secureDNS?: { delegationSigned?: boolean }
}

export async function rdap(domain: string): Promise<Registration> {
  const empty: Registration = {
    registrar: null,
    registrarUrl: null,
    expiresIn: null,
    expiresOn: null,
    registeredAgo: null,
    changedAgo: null,
    status: [],
    signed: null,
    nameservers: [],
    note: null,
  }

  const body = await getJson<RdapDomain>(`${RDAP}/${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json' },
  })
  if (body === null) return { ...empty, note: 'The registry’s RDAP service did not answer.' }

  const when = (action: string): string | undefined =>
    body.events?.find((e) => e.eventAction === action)?.eventDate
  const expiry = when('expiration')
  const registrar = body.entities?.find((e) => (e.roles ?? []).includes('registrar'))

  return {
    registrar: vcardName(registrar),
    // The registrar's own RDAP base doubles as the only link the registry
    // publishes for them, and it is where a renewal actually happens.
    registrarUrl:
      (registrar?.links ?? [])
        .map((l) => l.href ?? '')
        .find((h) => !h.includes('identitydigital')) ?? null,
    expiresIn: expiry === undefined ? null : (Date.parse(expiry) - Date.now()) / 1000,
    expiresOn: expiry === undefined ? null : localDay(Date.parse(expiry)),
    registeredAgo: age(when('registration')),
    changedAgo: age(when('last changed')),
    status: body.status ?? [],
    // The REGISTRY's view, which is the one that decides whether a resolver
    // validates: Cloudflare can hold signing keys all it likes, but until the
    // DS record is in the parent zone nothing checks them.
    signed: body.secureDNS?.delegationSigned ?? null,
    nameservers: (body.nameservers ?? []).map((n) => (n.ldhName ?? '').toLowerCase()).sort(),
    note: null,
  }
}

/** The `fn` entry out of an RDAP vCard — a registrar's display name. */
function vcardName(entity: RdapEntity | undefined): string | null {
  const fields = (entity?.vcardArray?.[1] ?? []) as unknown[]
  for (const f of fields) {
    if (Array.isArray(f) && f[0] === 'fn' && typeof f[3] === 'string' && f[3] !== '') return f[3]
  }
  return null
}
