import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  callbackUrl,
  type EnrollQuery,
  isIpv4,
  navigationAllowed,
  parseEnrollQuery,
  parseWgQuick,
  typedMatches,
} from '../lib/agent/enroll'
import type { Result } from '../lib/result'
import type { EnrollRedeemed } from './controller/generated'
import type { DesiredSync } from './controller/nodes'
import { nodeIdOf } from './controller/nodes'
import type { SystemInfo } from './controller/wire'
import type { WgEasy } from './wg-easy'

// A Mac's log-in, the app's half (agent/src/enroll.rs is the machine's; the
// flow is agent/README.md "Logging in (macOS)"):
//
//   GET  /agent/enroll        the page: the machine's name and fingerprint, and
//                             a one-time form token — minted only for a page
//                             the menu bar opened (lib/agent/enroll.ts
//                             `navigationAllowed` says what that means)
//   Confirm (adminFn)         the token and the fingerprint's first characters
//                             as the admin typed them from the menu bar →
//                             the node approved and handed to the controller,
//                             a wg-easy client made and confined, a single-use
//                             code → the browser to the machine's loopback
//   POST /api/agent/enroll    the machine's service, outside forward-auth:
//                             the code and its PKCE verifier → the client's
//                             config, the controller's pin and address
//
// Confirm undoes what it did when a step fails: the client deleted, the node
// put back as it was and the controller told. The code is spent by its first
// redeem, right or wrong, and lives five minutes. The client's private key is
// wg-easy's to keep: read at redeem and handed to the machine's service,
// never stored here and never logged.
//
// Everything that reaches the machine is passed in (`EnrollDeps`), so the
// tests drive the whole flow with fakes; server/enroll.ts and
// routes/api.agent.enroll.ts build the real ones.

/** How long the page's form token and a Confirm's code live. */
export const FORM_TOKEN_MS = 10 * 60_000
export const CODE_MS = 5 * 60_000
/** At most this many pages waiting for a Confirm at once; the oldest goes first. */
const FORM_TOKENS_MAX = 32

/** A wg-easy client's MTU and keepalive, as the agent's tunnel expects them. */
const TUNNEL_MTU = 1280
const TUNNEL_KEEPALIVE = 25

// ── keys, codes, PKCE ──────────────────────────────────────────────────────

/** The fingerprint the menu bar shows: SHA-256 of the key, hex in groups of four (identity.rs). */
export function fingerprintOf(publicKeyHex: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
  return (hex.match(/.{4}/g) ?? []).join(':')
}

/** 32 random bytes, base64url: a form token, a code. */
const token = (): string => randomBytes(32).toString('base64url')

/** What a code is stored as. */
export const codeHash = (code: string): string =>
  createHash('sha256').update(code, 'utf8').digest('hex')

/** PKCE S256 (RFC 7636 §4.6): base64url(SHA-256(verifier)) against the challenge, in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const got = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'))
  const want = Buffer.from(challenge)
  return got.length === want.length && timingSafeEqual(got, want)
}

// ── the page's form token ──────────────────────────────────────────────────

/** What a page's token binds: exactly the machine it showed, to the admin it showed it to. */
export type FormToken = {
  query: EnrollQuery
  fingerprint: string
  actor: string
  expiresAt: number
}

const TOKENS = Symbol.for('daedalus.enroll.formTokens')
function tokens(): Map<string, FormToken> {
  const g = globalThis as unknown as Record<symbol, Map<string, FormToken> | undefined>
  let m = g[TOKENS]
  if (m === undefined) {
    m = new Map()
    g[TOKENS] = m
  }
  return m
}

/** A one-time token for the page just shown. Kept in memory: a restart asks for the page again. */
export function mintFormToken(t: Omit<FormToken, 'expiresAt'>, now = Date.now()): string {
  const m = tokens()
  for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k)
  while (m.size >= FORM_TOKENS_MAX) {
    const oldest = m.keys().next().value
    if (oldest === undefined) break
    m.delete(oldest)
  }
  const id = token()
  m.set(id, { ...t, expiresAt: now + FORM_TOKEN_MS })
  return id
}

/** The token's binding, spent: a second use of the same token finds nothing. */
export function takeFormToken(id: string, now = Date.now()): FormToken | null {
  const m = tokens()
  const t = m.get(id)
  if (t === undefined) return null
  m.delete(id)
  return t.expiresAt > now ? t : null
}

// ── what the flow reaches ──────────────────────────────────────────────────

/** A node row as a log-in reads and restores it. */
export type NodeStanding = {
  state: 'approved' | 'revoked'
  approvedAt: Date | null
  approvedBy: string | null
  revokedAt: Date | null
}

export type Tunnel = { clientId: number; address: string }

export type CodeRow = {
  codeHash: string
  nodeId: string
  clientId: number
  challenge: string
  controllerPin: string
  controllerAddress: string
  expiresAt: Date
}

/** The database, as the flow uses it (lib/repo/enroll.ts is the real one). */
export type EnrollStore = {
  standing: (id: string) => Promise<NodeStanding | null>
  /** Approve the node for this log-in: a new row from the page's facts, or the old one trusted again. The standing before. */
  approve: (row: {
    id: string
    publicKey: string
    hostname: string
    os: string
    arch: string
    agentVersion: string
    by: string
  }) => Promise<NodeStanding | null>
  /** Put the node back: `prior` null deletes the row this log-in made. */
  restore: (id: string, prior: NodeStanding | null) => Promise<void>
  tunnelOf: (id: string) => Promise<Tunnel | null>
  setTunnel: (id: string, t: Tunnel) => Promise<void>
  deleteTunnel: (id: string) => Promise<void>
  putCode: (row: CodeRow) => Promise<void>
  /** The row, deleted in the same statement: whoever takes it first spends it. */
  takeCode: (hash: string) => Promise<CodeRow | null>
}

export type EnrollDeps = {
  store: EnrollStore
  wg: WgEasy
  systemInfo: () => Promise<SystemInfo>
  /** The whole desired set to the controller, and its answer (host/controller/nodes.ts). */
  sync: () => Promise<DesiredSync>
  /** The box's LAN address: the one address a tunnel reaches. */
  lanIp: string
  /** WG_EASY_HOST_ALIAS: where the tunnel's host ports land after wg-easy's DNAT. */
  hostAlias: string
  sessionHostPort: number
  now?: () => number
  log?: (line: string) => void
}

/** A refusal with `retry` left the page's token unspent: the same page may try again. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string; retry?: true }

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The port of `host:port`, or null. */
export function portOf(address: string | null | undefined): number | null {
  const m = /:(\d{1,5})$/.exec(address ?? '')
  const n = m === null ? Number.NaN : Number(m[1])
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/** wg-easy's name for the client: the machine's, recognisable in its UI. */
export function clientName(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `daedalus-${slug === '' ? 'machine' : slug}`.slice(0, 32)
}

/** wg-easy's per-client firewall is off until something turns it on; a log-in does, once. */
async function ensureFirewall(wg: WgEasy): Promise<boolean> {
  const iface = await wg.getInterface()
  if (iface.firewallEnabled === true) return false
  await wg.updateInterface({ ...iface, firewallEnabled: true })
  const after = await wg.getInterface()
  if (after.firewallEnabled !== true) {
    throw new Error("wg-easy's per-client firewall did not turn on (is iptables there?)")
  }
  return true
}

// ── Confirm ────────────────────────────────────────────────────────────────

/**
 * The admin's Confirm: spend the page's token, and — only if the typed
 * characters are the fingerprint's — approve the node, wait for the
 * controller's answer, make and confine its wg-easy client, and mint the code.
 * The browser's next stop, or why not with everything undone.
 */
export async function confirmEnroll(
  deps: EnrollDeps,
  input: { token: string; typed: string; actor: string },
): Promise<Outcome<{ callback: string; nodeId: string }>> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.info(l))

  // Everything the answer names about the box, read before the token is
  // spent: a box that cannot answer leaves the page usable once it can.
  if (!isIpv4(deps.lanIp)) {
    return { ok: false, reason: 'The box’s LAN address is not known here.', retry: true }
  }
  if (deps.hostAlias === '')
    return { ok: false, reason: 'WG_EASY_HOST_ALIAS is not set.', retry: true }
  let pin: string
  let port: number
  try {
    const c = (await deps.systemInfo()).controller
    const p = portOf(c?.advertise[0]) ?? portOf(c?.listen)
    if (c === null || p === null) throw new Error('it says nowhere machines reach it')
    pin = c.fingerprint
    port = p
  } catch (e) {
    return { ok: false, reason: `The controller could not be asked: ${why(e)}`, retry: true }
  }

  const t = takeFormToken(input.token, now())
  if (t === null) {
    return {
      ok: false,
      reason: 'This page has expired or was used. Choose Log in… in the menu bar again.',
    }
  }
  if (t.actor !== input.actor) {
    return {
      ok: false,
      reason: 'This page was opened by someone else. Choose Log in… in the menu bar again.',
    }
  }
  if (!typedMatches(t.fingerprint, input.typed)) {
    return {
      ok: false,
      reason:
        'Those are not the first characters of this Mac’s fingerprint. Choose Log in… in the menu bar again.',
    }
  }
  const q = t.query
  const id = nodeIdOf(q.key)
  let prior: NodeStanding | null
  try {
    prior = await deps.store.approve({
      id,
      publicKey: q.key,
      hostname: q.name,
      os: q.os,
      arch: q.arch,
      agentVersion: q.version,
      by: input.actor,
    })
  } catch (e) {
    return { ok: false, reason: `The machine could not be approved: ${why(e)}` }
  }

  let clientId: number | null = null
  let old: Tunnel | null = null
  let mapped = false
  const undo = async (reason: string): Promise<Outcome<never>> => {
    const left: string[] = []
    if (clientId !== null) {
      await deps.wg.deleteClient(clientId).catch((e: unknown) => {
        left.push(`wg-easy client ${String(clientId)} (${why(e)})`)
      })
    }
    if (mapped) {
      await (old === null ? deps.store.deleteTunnel(id) : deps.store.setTunnel(id, old)).catch(
        (e: unknown) => left.push(`the tunnel's record (${why(e)})`),
      )
    }
    await deps.store.restore(id, prior).catch((e: unknown) => left.push(`the node (${why(e)})`))
    const s = await deps.sync()
    if (s.error !== null) left.push(`the controller's set (${s.error})`)
    log(
      `enroll: ${id} not logged in, undone: ${reason}${left.length > 0 ? `; NOT undone: ${left.join(', ')}` : ''}`,
    )
    return {
      ok: false,
      reason:
        left.length === 0
          ? `${reason} Nothing was changed.`
          : `${reason} Undoing it left ${left.join(', ')} behind.`,
    }
  }

  // The controller first: the machine's key is approved before its tunnel
  // exists, so its first connection through it is answered.
  const s = await deps.sync()
  if (s.error !== null) return undo(`The controller did not take the approval: ${s.error}.`)
  if (!s.sent.some((n) => n.id === id && n.state === 'approved')) {
    return undo('The controller’s set did not carry this machine.')
  }

  try {
    if (await ensureFirewall(deps.wg)) log("enroll: wg-easy's per-client firewall turned on")
    clientId = await deps.wg.createClient(clientName(q.name))
    const made = await deps.wg.getClient(clientId)
    await deps.wg.updateClient(clientId, {
      ...made,
      allowedIps: [`${deps.lanIp}/32`],
      firewallIps: [
        `${deps.hostAlias}:${String(port)}/tcp`,
        `${deps.hostAlias}:${String(deps.sessionHostPort)}/tcp`,
      ],
      mtu: TUNNEL_MTU,
      persistentKeepalive: TUNNEL_KEEPALIVE,
    })
    const config = parseWgQuick(await deps.wg.configuration(clientId))
    if (config.allowed_ips.length !== 1 || config.allowed_ips[0] !== `${deps.lanIp}/32`) {
      throw new Error('wg-easy kept another AllowedIPs for the client')
    }
    old = await deps.store.tunnelOf(id)
    mapped = true
    await deps.store.setTunnel(id, { clientId, address: config.address })
    const code = token()
    await deps.store.putCode({
      codeHash: codeHash(code),
      nodeId: id,
      clientId,
      challenge: q.challenge,
      controllerPin: pin,
      controllerAddress: `${deps.lanIp}:${String(port)}`,
      expiresAt: new Date(now() + CODE_MS),
    })
    // A client left from an earlier log-in whose log-out the app never heard.
    if (old !== null && old.clientId !== clientId) {
      const stale = old.clientId
      await deps.wg.deleteClient(stale).catch((e: unknown) => {
        log(`enroll: ${id}'s earlier wg-easy client ${String(stale)} not deleted: ${why(e)}`)
      })
    }
    log(
      `enroll: ${id} (${q.name}) approved by ${input.actor}; wg-easy client ${String(clientId)} at ${config.address}`,
    )
    return {
      ok: true,
      value: { callback: callbackUrl(q.port, { state: q.state, code }), nodeId: id },
    }
  } catch (e) {
    return undo(`The tunnel could not be made: ${why(e)}.`)
  }
}

// ── the redeem ─────────────────────────────────────────────────────────────

/** What the redeem route answers: a status and a JSON body. */
export type Answer = { status: number; body: EnrollRedeemed | { error: string } }

const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/
/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

/** The request body, checked: `{code, code_verifier}` and nothing else. */
export function redeemBody(v: unknown): Outcome<{ code: string; verifier: string }> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, reason: 'the body is not a JSON object' }
  }
  const o = v as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => k !== 'code' && k !== 'code_verifier')
  if (extra.length > 0) return { ok: false, reason: `unknown fields: ${extra.join(', ')}` }
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) {
    return { ok: false, reason: 'code is not one this app hands out' }
  }
  if (typeof o.code_verifier !== 'string' || !VERIFIER_RE.test(o.code_verifier)) {
    return { ok: false, reason: 'code_verifier is not a PKCE verifier' }
  }
  return { ok: true, value: { code: o.code, verifier: o.code_verifier } }
}

/**
 * A machine's service redeems its code. The code is spent before anything is
 * checked, so a wrong verifier costs the log-in, not a second try.
 */
export async function redeemEnroll(
  deps: Pick<EnrollDeps, 'store' | 'wg' | 'now' | 'log'>,
  body: unknown,
): Promise<Answer> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.info(l))
  const refuse = (status: number, error: string): Answer => ({ status, body: { error } })
  const b = redeemBody(body)
  if (!b.ok) return refuse(400, b.reason)
  const row = await deps.store.takeCode(codeHash(b.value.code))
  if (row === null) return refuse(400, 'this code is unknown or was used; log in again')
  if (row.expiresAt.getTime() <= now()) return refuse(400, 'this code expired; log in again')
  if (!pkceMatches(b.value.verifier, row.challenge)) {
    log(`enroll: a redeem for ${row.nodeId} with the wrong verifier; the code is spent`)
    return refuse(400, 'the verifier does not match; log in again')
  }
  const standing = await deps.store.standing(row.nodeId)
  if (standing?.state !== 'approved') {
    return refuse(409, 'this machine is no longer approved; log in again')
  }
  const tunnel = await deps.store.tunnelOf(row.nodeId)
  if (tunnel?.clientId !== row.clientId) {
    return refuse(409, 'this log-in’s tunnel was replaced or removed; log in again')
  }
  let wireguard: EnrollRedeemed['wireguard']
  try {
    wireguard = parseWgQuick(await deps.wg.configuration(row.clientId))
  } catch (e) {
    log(`enroll: ${row.nodeId}'s tunnel config could not be read: ${why(e)}`)
    return refuse(502, `the tunnel's config could not be read: ${why(e)}`)
  }
  log(`enroll: ${row.nodeId} redeemed its log-in (wg-easy client ${String(row.clientId)})`)
  return {
    status: 200,
    body: {
      node: row.nodeId,
      controller: { pin: row.controllerPin, address: row.controllerAddress },
      wireguard,
    },
  }
}

// ── a machine that leaves ──────────────────────────────────────────────────

/**
 * Delete the node's wg-easy client and its record. Best effort, and never a
 * throw: a record whose client could not be deleted stays, and the next
 * revoke, forget or log-in deletes it. Without wg-easy configured, nothing.
 */
export async function releaseTunnel(
  deps: { store: Pick<EnrollStore, 'tunnelOf' | 'deleteTunnel'>; wg: WgEasy | null },
  id: string,
  log: (line: string) => void = (l) => console.warn(l),
): Promise<boolean> {
  try {
    const t = await deps.store.tunnelOf(id)
    if (t === null) return false
    if (deps.wg === null) {
      log(
        `enroll: ${id}'s wg-easy client ${String(t.clientId)} kept: this box binds no WG_EASY_URL`,
      )
      return false
    }
    await deps.wg.deleteClient(t.clientId)
    await deps.store.deleteTunnel(id)
    console.info(`enroll: ${id}'s wg-easy client ${String(t.clientId)} deleted`)
    return true
  } catch (e) {
    log(`enroll: ${id}'s tunnel not released: ${why(e)}`)
    return false
  }
}

// ── the page ───────────────────────────────────────────────────────────────

/** The enroll page, as its GET decides it (routes/agent.enroll.tsx draws it). */
export type EnrollPage =
  /** The URL is not one the menu bar makes: nothing can be sent back. */
  | { kind: 'invalid'; reason: string }
  /** This box cannot make tunnels (no WG_EASY_URL yet). */
  | { kind: 'unavailable'; name: string; declineUrl: string }
  /** The viewer may not let a machine in (core/authz.ts): no token. */
  | { kind: 'forbidden'; reason: string; name: string; declineUrl: string }
  /** Not opened by the menu bar (lib/agent/enroll.ts `navigationAllowed`): no token. */
  | { kind: 'refused'; reason: string; name: string; declineUrl: string }
  | { kind: 'refused'; reason: string; name: string; declineUrl: string }
  | {
      kind: 'ready'
      token: string
      machine: {
        id: string
        name: string
        os: string
        arch: string
        version: string
        fingerprint: string
      }
      /** What the box already decided about this key. */
      standing: 'new' | 'approved' | 'revoked'
      declineUrl: string
    }

export type PageRequest = {
  /** The request's own path and query, as the browser sent them. */
  path: string
  search: string
  site: string | null
  mode: string | null
  dest: string | null
  referer: string | null
}

/**
 * The page for this request: the URL checked, the box able to make a tunnel,
 * the navigation the menu bar's — and only then a form token, bound to what
 * the page shows and to who it shows it to.
 *
 * The admin gate is here rather than in front of the GET, and after the two
 * checks that change nothing: a page that cannot mint anything answers
 * anyone past forward-auth, and a refusal is a page, not an error.
 */
export async function enrollPage(
  req: PageRequest,
  deps: {
    /** The admin gate's answer (core/authz.ts `allow`): the actor, or why not. */
    authorize: () => Promise<Result<string>>
    available: boolean
    idpOrigin: string | null
    standing: (id: string) => Promise<NodeStanding | null>
    now?: number
  },
): Promise<EnrollPage> {
  if (req.path !== '/agent/enroll') {
    return { kind: 'invalid', reason: 'this page loads only as a page of its own' }
  }
  const parsed = parseEnrollQuery(req.search)
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
  const q = parsed.value
  const declineUrl = callbackUrl(q.port, { state: q.state, error: 'denied' })
  if (!deps.available) return { kind: 'unavailable', name: q.name, declineUrl }
  const actor = await deps.authorize()
  if (!actor.ok) return { kind: 'forbidden', reason: actor.reason, name: q.name, declineUrl }
  const nav = navigationAllowed(req, deps.idpOrigin)
  if (!nav.ok) return { kind: 'refused', reason: nav.reason, name: q.name, declineUrl }
  const id = nodeIdOf(q.key)
  const fingerprint = fingerprintOf(q.key)
  const row = await deps.standing(id)
  return {
    kind: 'ready',
    token: mintFormToken({ query: q, fingerprint, actor: actor.value }, deps.now),
    machine: { id, name: q.name, os: q.os, arch: q.arch, version: q.version, fingerprint },
    standing: row === null ? 'new' : row.state,
    declineUrl,
  }
}
