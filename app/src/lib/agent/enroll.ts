import type { WireguardConfig } from '../../host/controller/generated'
import { MAX_HOSTNAME } from '../../host/controller/generated/constants'
import { hasControlChar } from './policy'

// A Mac's log-in (agent/src/node/enroll.rs), the pure half: what the enroll page
// takes from the URL the menu bar opened, where the browser goes afterwards,
// and the wg-quick text wg-easy hands out. The half that holds secrets,
// reaches the database, the controller and wg-easy is host/enroll.ts; the
// page is routes/agent.enroll.tsx.
//
// Pure, and importable by the page: nothing here hashes (node:crypto is the
// host's), so the fingerprint arrives already computed.

/** What `enroll_url` (enroll.rs) puts in the query, checked. */
export type EnrollQuery = {
  /** The machine's link key, 64 lowercase hex characters. */
  key: string
  /** Its hostname, as the agent reads it: shown, and the row's until its first hello. */
  name: string
  os: string
  arch: string
  version: string
  /** The loopback port the menu bar listens on for the callback. */
  port: number
  /** The log-in's `state`, handed back on the callback untouched. */
  state: string
  /** PKCE S256: base64url of SHA-256 of the verifier the machine's service keeps. */
  challenge: string
}

const FIELDS = [
  'key',
  'name',
  'os',
  'arch',
  'version',
  'port',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const

const HEX64 = /^[0-9a-f]{64}$/
/** An OS, an architecture: one short word. */
const WORD = /^[A-Za-z0-9._-]{1,32}$/
/** A version: `0.23.0`, `0.23.0-rc.1+abc`. */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/
/** 32 random bytes as base64url is 43 characters; room for a longer one, never unbounded. */
const STATE = /^[A-Za-z0-9_-]{43,128}$/
/** SHA-256 as base64url, unpadded: exactly 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const PORT = /^[1-9][0-9]{3,4}$/

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * The query of `/agent/enroll`, from its raw text (`?key=…&name=…`), checked
 * field by field. A key twice, a field this page does not know, a field
 * missing: refused. Every refusal names the field and never echoes a value.
 */
export function parseEnrollQuery(search: string): Checked<EnrollQuery> {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const got = new Map<string, string>()
  for (const [k, v] of params) {
    if (!(FIELDS as readonly string[]).includes(k)) return bad(`${k} is not part of a log-in link`)
    if (got.has(k)) return bad(`${k} appears twice`)
    got.set(k, v)
  }
  for (const f of FIELDS) if (!got.has(f)) return bad(`${f} is missing`)
  const v = (f: (typeof FIELDS)[number]) => got.get(f) ?? ''

  if (!HEX64.test(v('key'))) return bad('key is not 64 lowercase hex characters')
  // The machine's hostname, which its hello carries: at most MAX_HOSTNAME bytes.
  const name = v('name').trim()
  if (name === '' || new TextEncoder().encode(name).length > MAX_HOSTNAME || hasControlChar(name)) {
    return bad(`name is not a machine name of 1 to ${String(MAX_HOSTNAME)} bytes of printable text`)
  }
  for (const f of ['os', 'arch'] as const) {
    if (!WORD.test(v(f))) return bad(`${f} is not one short word`)
  }
  if (!VERSION.test(v('version'))) return bad('version is not a version')
  const portText = v('port')
  const port = Number(portText)
  if (!PORT.test(portText) || port < 1024 || port > 65535) {
    return bad('port is not a port from 1024 to 65535')
  }
  if (!STATE.test(v('state'))) return bad('state is not base64url of 43 to 128 characters')
  if (!CHALLENGE.test(v('code_challenge'))) {
    return bad('code_challenge is not a SHA-256 in base64url')
  }
  if (v('code_challenge_method') !== 'S256') return bad('code_challenge_method is not S256')
  return {
    ok: true,
    value: {
      key: v('key'),
      name,
      os: v('os'),
      arch: v('arch'),
      version: v('version'),
      port,
      state: v('state'),
      challenge: v('code_challenge'),
    },
  }
}

function bad(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

/**
 * The menu bar's loopback (enroll.rs `Loopback`): the only place a log-in's
 * answer goes. `http` on 127.0.0.1 is what it binds; nothing else is ever built.
 */
export function callbackUrl(
  port: number,
  params: { state: string } & ({ code: string } | { error: 'denied' }),
): string {
  const q = new URLSearchParams({ state: params.state })
  if ('code' in params) q.set('code', params.code)
  else q.set('error', params.error)
  return `http://127.0.0.1:${String(port)}/callback?${q.toString()}`
}

// ── the navigation that brought the page ─────────────────────────────────────

/**
 * Whether the GET of the page may mint the form token, from the request's
 * Fetch Metadata. Measured in Chromium (a real forward-auth round trip,
 * reproduced with servers on same-site and cross-site origins):
 *
 *   the menu bar opens the URL, already signed in     none
 *   … signed out, the IdP answers without a prompt    none (302s keep it)
 *   … signed out, the operator signs in at the IdP    same-site, Referer = the IdP's origin
 *   a link on another app of this domain               same-site, Referer = that app
 *   a link on any other site                           cross-site
 *   a link elsewhere, THEN a sign-in at the IdP        same-site, Referer = the IdP's origin
 *
 * So `none` is the menu bar, and `same-site` is accepted only when the
 * Referer is the IdP's origin: the sign-in on the way here. The last row is
 * the residue — a stranger's link that happens to need a sign-in looks like
 * the menu bar's — and the page itself is what stops it: it names the
 * machine and shows its full key, and asks the admin to confirm only a log-in
 * they just asked for from that machine.
 *
 * Anything but a top-level document navigation (the router's own fetch, an
 * iframe), and a browser that sends no Fetch Metadata at all, are refused.
 */
export function navigationAllowed(
  h: { site: string | null; mode: string | null; dest: string | null; referer: string | null },
  idpOrigin: string | null,
): Checked<'direct' | 'after-sign-in'> {
  if (h.mode !== 'navigate' || (h.dest !== null && h.dest !== 'document')) {
    return bad('this page loads only as a page of its own')
  }
  if (h.site === 'none') return { ok: true, value: 'direct' }
  if (h.site === 'same-site' && idpOrigin !== null && h.referer !== null) {
    let from: string | null = null
    try {
      from = new URL(h.referer).origin
    } catch {
      from = null
    }
    if (from === idpOrigin) return { ok: true, value: 'after-sign-in' }
  }
  return bad(
    h.site === null
      ? 'this browser did not say how it got here'
      : `this page was opened from ${h.site === 'same-origin' ? 'this app' : 'another page'}`,
  )
}

// ── wg-easy's client config ──────────────────────────────────────────────────

/**
 * wg-easy's client configuration (wg-quick text, `GET
 * /api/client/:id/configuration`) as the redeem answer carries it
 * (api/wire.rs `WireguardConfig`): the IPv4 address alone, AllowedIPs as a
 * list. Throws, naming the field, on anything the agent would refuse; the
 * message never carries a key.
 */
export function parseWgQuick(text: string): WireguardConfig {
  const sections: Record<string, Map<string, string>> = {}
  let at: Map<string, string> | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const head = /^\[(\w+)\]$/.exec(line)
    if (head !== null) {
      const name = head[1] as string
      if (sections[name] !== undefined) throw new Error(`the config has two [${name}] sections`)
      at = new Map()
      sections[name] = at
      continue
    }
    const eq = line.indexOf('=')
    if (at === null || eq < 1) throw new Error('the config has a line outside key = value')
    at.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const iface = sections.Interface
  const peer = sections.Peer
  if (iface === undefined || peer === undefined) {
    throw new Error('the config lacks its [Interface] or [Peer]')
  }
  const need = (m: Map<string, string>, k: string) => {
    const v = m.get(k)
    if (v === undefined || v === '') throw new Error(`the config has no ${k}`)
    return v
  }
  const list = (v: string) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')

  const privateKey = need(iface, 'PrivateKey')
  const serverKey = need(peer, 'PublicKey')
  const psk = peer.get('PresharedKey')
  for (const [what, k] of [
    ['PrivateKey', privateKey],
    ['PublicKey', serverKey],
    ...(psk === undefined ? [] : [['PresharedKey', psk]]),
  ] as const) {
    if (!WG_KEY.test(k)) throw new Error(`the config's ${what} is not a WireGuard key`)
  }
  const v4 = list(need(iface, 'Address'))
    .map((a) => a.split('/')[0] as string)
    .find((a) => IPV4.test(a))
  if (v4 === undefined) throw new Error('the config has no IPv4 Address')
  const allowed = list(need(peer, 'AllowedIPs'))
  const endpoint = need(peer, 'Endpoint')
  if (!/^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$/.test(endpoint)) {
    throw new Error('the config’s Endpoint is not host:port')
  }
  return {
    private_key: privateKey,
    address: v4,
    server_public_key: serverKey,
    ...(psk === undefined ? {} : { preshared_key: psk }),
    endpoint,
    allowed_ips: allowed,
  }
}

/** A WireGuard key: 32 bytes, base64 with its padding. */
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/** Whether `s` is a dotted IPv4 address. */
export const isIpv4 = (s: string): boolean => IPV4.test(s)
