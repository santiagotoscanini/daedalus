import { createHash, createPrivateKey, randomBytes } from 'node:crypto'
import { readCommittedSite } from '../../lib/contract/domains/site-doc'
import {
  buildManifest,
  GITHUB_APP_EVENTS,
  GITHUB_APP_FILE,
  GITHUB_APP_PERMISSIONS,
  installUrl,
} from '../../lib/github-app'
import { safeEqual } from '../../lib/github-app-crypto'
import { publicInstallation } from '../../lib/github-token'
import { getJsonResult } from '../../lib/http'
import { isRecord } from '../../lib/is-record'
import { BASE_DOMAIN, OWNER } from '../../lib/site'
import type { Ctx } from '../ctx'
import { GITHUB_API, GITHUB_API_VERSION, installationState } from '../github-app'
import { renderSiteFile, type SiteDocument, type SiteGithubApp } from '../site/file'
import { sealJsonForVault } from '../vault'
import type {
  GithubAppApply,
  GithubAppDiscard,
  GithubAppFinish,
  GithubAppStart,
  GithubAppState,
  GithubAppStatus,
  GithubCallbackCode,
} from './types'

// Settings › Integrations › GitHub App: the box registers its own GitHub App
// through GitHub's manifest flow.
//
//   start    the page POSTs a manifest to github.com with a random state; only
//            the state's hash is kept, bound to who started and to the owner's
//            numeric account id, for an hour.
//   finish   GitHub sends the browser to /settings/github/callback with a code.
//            Under the finish lock the creation record is read and compared
//            (state, actor, expiry) and consumed only on a match; then the
//            code is exchanged once for the App's credentials, which are sealed
//            for site/vault/ HERE and applied beside the App's public ids in
//            site.json. A refused Apply keeps the ciphertext (never the
//            plaintext) for "Retry Apply" or "Discard".
//   paste    recovery: a new private key, with a new webhook and client secret,
//            because this container can seal secrets but never read them back.
//
// The private key exists in this process only between the conversion reply
// and the seal. No result, error or log line below carries it, the webhook
// secret, the client secret or the code.
//
// Every mutation refuses until the host can take the vault file
// (GITHUB_APP_ENABLED=1, set by the nix change that teaches apply.sh and sops
// about it): an App created earlier would lose its key in the Apply. Every
// mutation also refuses without a signed-in identity (actorFrom).

export const APP_NAME_MAX = 34
const CREATION_TTL_MS = 60 * 60_000
const OWNER_ATTEMPTS = [3_000, 8_000]
const CONVERSION_TIMEOUT_MS = 8_000
const VAULT_NAME = 'github-app'

export const DISABLED_REASON = 'Waiting for the host to support GitHub Apps.'
export const NO_ACTOR_REASON = 'The request carried no signed-in identity, so nothing was done.'

const enabled = (ctx: Ctx): boolean => ctx.env('GITHUB_APP_ENABLED') === '1'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': GITHUB_API_VERSION,
  'User-Agent': 'daedalus',
}

/**
 * The operator, from the gate's X-Forwarded-Email. Missing or blank is null,
 * never a placeholder: two requests without an identity must not match each
 * other as the same actor.
 */
export function actorFrom(header: string | null | undefined): string | null {
  const v = header?.trim() ?? ''
  return v === '' ? null : v
}

// ── stored records ─────────────────────────────────────────────────────────

type CreationRecord = {
  stateHash: string
  actor: string
  ownerId: number
  expiresAt: number
  replace: boolean
}

const isCreation = (v: unknown): v is CreationRecord =>
  isRecord(v) &&
  typeof v.stateHash === 'string' &&
  /^[0-9a-f]{64}$/.test(v.stateHash) &&
  typeof v.actor === 'string' &&
  typeof v.ownerId === 'number' &&
  typeof v.expiresAt === 'number' &&
  typeof v.replace === 'boolean'

/**
 * A created App whose Apply was refused. Ciphertext only, plus the site.json
 * App it was created to follow (`priorAppId`, null when there was none): a
 * retry must not overwrite an App committed since.
 */
type PendingApply = {
  ciphertext: string
  github: SiteGithubApp
  at: string
  reason: string
  replace: boolean
  priorAppId: number | null
}

const isApp = (v: unknown): v is SiteGithubApp =>
  isRecord(v) &&
  typeof v.id === 'number' &&
  typeof v.slug === 'string' &&
  typeof v.clientId === 'string' &&
  typeof v.htmlUrl === 'string' &&
  typeof v.owner === 'string' &&
  typeof v.ownerId === 'number'

const isPendingApply = (v: unknown): v is PendingApply =>
  isRecord(v) &&
  typeof v.ciphertext === 'string' &&
  isApp(v.github) &&
  typeof v.at === 'string' &&
  typeof v.reason === 'string' &&
  typeof v.replace === 'boolean' &&
  (v.priorAppId === null || typeof v.priorAppId === 'number')

// ── pure checks ────────────────────────────────────────────────────────────

/** Why GitHub would refuse this App name, or null. GitHub caps names at 34 characters. */
export function appNameError(name: string): string | null {
  if (name === '') return 'Give the App a name.'
  if ([...name].length > APP_NAME_MAX) {
    return `GitHub allows at most ${String(APP_NAME_MAX)} characters in an App name.`
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    return 'Use letters, digits, spaces, dots, dashes and underscores, starting with a letter or digit.'
  }
  return null
}

/** `daedalus-<first label of the base domain>`. */
export function defaultAppName(baseDomain: string): string {
  const label = (baseDomain.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '')
  const name = label === '' ? 'daedalus' : `daedalus-${label}`
  return name.slice(0, APP_NAME_MAX).replace(/-+$/, '')
}

const PEM_HEAD = '-----BEGIN RSA PRIVATE KEY-----'
const PEM_FOOT = '-----END RSA PRIVATE KEY-----'
const PEM_MAX = 16_384

function pemLines(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => l.trim())
}

/** Why this is not a GitHub App private key (PKCS#1 RSA PEM), or null. Never repeats the key. */
export function pemError(raw: string): string | null {
  if (raw.trim() === '') return 'Paste the private key.'
  if (raw.length > PEM_MAX) return 'That is longer than any GitHub App private key.'
  const lines = pemLines(raw)
  if (lines[0] !== PEM_HEAD || lines[lines.length - 1] !== PEM_FOOT) {
    return `Paste the whole key, from ${PEM_HEAD} to ${PEM_FOOT}.`
  }
  const body = lines.slice(1, -1)
  if (body.length === 0 || !body.every((l) => /^[A-Za-z0-9+/]+={0,2}$/.test(l))) {
    return 'The lines between the header and the footer are not a key.'
  }
  try {
    const key = createPrivateKey({ key: lines.join('\n'), format: 'pem' })
    if (key.asymmetricKeyType !== 'rsa') return 'That is not an RSA key.'
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      return 'That RSA key is shorter than any GitHub issues.'
    }
  } catch {
    return 'That does not read as an RSA private key.'
  }
  return null
}

/** The key as it is sealed: LF line ends, no stray indentation, one trailing newline. */
const sealablePem = (raw: string): string => `${pemLines(raw).join('\n')}\n`

function secretError(label: string, value: string): string | null {
  if (value === '') return `Enter the new ${label}.`
  if (value !== value.trim()) return `The ${label} starts or ends with whitespace.`
  if (value.length > 256) return `The ${label} is longer than GitHub allows.`
  return null
}

const CODE_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Why the App GitHub registered is not the one the manifest asked for, or
 * null: exactly the manifest's permissions and events (both are required
 * fields of the conversion reply). Values only name permissions and events,
 * never a credential, so the reason is safe to log.
 */
export function grantError(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.permissions)) return 'the reply carries no permissions'
  const want: Record<string, string> = GITHUB_APP_PERMISSIONS
  const got = Object.entries(raw.permissions)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join(',')
  const expected = Object.entries(want)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(',')
  if (got !== expected) return `permissions ${got} differ from the manifest's ${expected}`
  const { events } = raw
  if (!Array.isArray(events) || !events.every((e) => typeof e === 'string')) {
    return 'the reply carries no events'
  }
  const gotEvents = [...new Set(events)].sort().join(',')
  const wantEvents = [...GITHUB_APP_EVENTS].sort().join(',')
  if (gotEvents !== wantEvents)
    return `events ${gotEvents} differ from the manifest's ${wantEvents}`
  return null
}

// ── start ──────────────────────────────────────────────────────────────────

type Owner = { id: number; login: string; type: string }

async function fetchOwner(): Promise<{ ok: true; owner: Owner } | { ok: false; reason: string }> {
  const res = await getJsonResult<{ id?: unknown; login?: unknown; type?: unknown }>(
    `${GITHUB_API}/users/${encodeURIComponent(OWNER)}`,
    { headers: GITHUB_HEADERS },
    OWNER_ATTEMPTS,
  )
  if (!res.ok) {
    return {
      ok: false,
      reason:
        res.status === null
          ? 'GitHub did not answer. Nothing changed.'
          : res.status === 404
            ? `GitHub has no account named ${OWNER}.`
            : `GitHub answered ${String(res.status)} when asked about ${OWNER}. Nothing changed.`,
    }
  }
  const { id, login, type } = res.body
  if (typeof id !== 'number' || typeof login !== 'string' || typeof type !== 'string') {
    return { ok: false, reason: `GitHub's answer about ${OWNER} was missing its account id.` }
  }
  if (login.toLowerCase() !== OWNER.toLowerCase()) {
    return { ok: false, reason: `GitHub answered for ${login}, not ${OWNER}.` }
  }
  return { ok: true, owner: { id, login, type } }
}

async function controlPlaneHost(ctx: Ctx, doc: SiteDocument): Promise<string | null> {
  const { baseDomain, controlPlane } = doc.identity
  if (controlPlane !== '' && baseDomain !== '') return `${controlPlane}.${baseDomain}`
  const { siteIdentity } = await import('../../lib/contract/domains/site')
  const host = (await siteIdentity()).data.controlPlane.hostname ?? ctx.env('APP_HOSTNAME') ?? ''
  return host === '' ? null : host
}

export async function startAppCreation(
  ctx: Ctx,
  actor: string | null,
  input: { replace?: boolean; name: string },
): Promise<GithubAppStart> {
  const refuse = (reason: string): GithubAppStart => ({ ok: false, reason })
  if (!enabled(ctx)) return refuse(DISABLED_REASON)
  if (actor === null) return refuse(NO_ACTOR_REASON)

  const name = input.name.trim()
  const badName = appNameError(name)
  if (badName !== null) return refuse(badName)

  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  if ((await ctx.store.read(SETTING_KEYS.githubAppPendingApply, isPendingApply)) !== undefined) {
    return refuse('A created App is still waiting for its Apply. Retry or discard that first.')
  }
  const { secretApplyBlocker } = await import('../../lib/apply-flow')
  const blocked = await secretApplyBlocker()
  if (blocked !== null) return refuse(blocked)

  const site = await readCommittedSite()
  if (!site.present) {
    return refuse(
      'There is no committed site.json to record the App in. Write it from the Site tab first.',
    )
  }
  const existing = site.doc.github?.app ?? null
  if (existing !== null && input.replace !== true) {
    return refuse(`This box already has a GitHub App, ${existing.slug}.`)
  }
  const host = await controlPlaneHost(ctx, site.doc)
  if (host === null) {
    return refuse(
      'The control plane’s address is not known yet, so GitHub would have nowhere to send you back.',
    )
  }

  const owner = await fetchOwner()
  if (!owner.ok) return refuse(owner.reason)

  const state = randomBytes(32).toString('base64url')
  const record: CreationRecord = {
    stateHash: sha256(state),
    actor,
    ownerId: owner.owner.id,
    expiresAt: Date.now() + CREATION_TTL_MS,
    replace: input.replace === true,
  }
  await ctx.store.write(SETTING_KEYS.githubAppCreation, record)

  const path =
    owner.owner.type === 'Organization'
      ? `https://github.com/organizations/${encodeURIComponent(owner.owner.login)}/settings/apps/new`
      : 'https://github.com/settings/apps/new'
  const manifest = buildManifest({
    name,
    baseDomain: site.doc.identity.baseDomain,
    controlPlaneHost: host,
  })
  return {
    ok: true,
    // GitHub's documented form carries `state` in the action's query string.
    action: `${path}?state=${encodeURIComponent(state)}`,
    manifest: JSON.stringify(manifest),
    state,
  }
}

// ── finish ─────────────────────────────────────────────────────────────────

type Conversion = SiteGithubApp & { pem: string; webhookSecret: string; clientSecret: string }

/** The conversion reply, or null. Says nothing about what it found: the reply holds the key. */
function readConversion(raw: unknown): Conversion | null {
  if (!isRecord(raw) || !isRecord(raw.owner)) return null
  const { id, slug, client_id, html_url, pem, webhook_secret, client_secret, owner } = raw
  if (
    typeof id !== 'number' ||
    typeof slug !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/.test(slug) ||
    typeof client_id !== 'string' ||
    typeof html_url !== 'string' ||
    !html_url.startsWith('https://github.com/') ||
    typeof pem !== 'string' ||
    typeof webhook_secret !== 'string' ||
    typeof client_secret !== 'string' ||
    typeof owner.id !== 'number' ||
    typeof owner.login !== 'string'
  ) {
    return null
  }
  return {
    id,
    slug,
    clientId: client_id,
    htmlUrl: html_url,
    owner: owner.login,
    ownerId: owner.id,
    pem,
    webhookSecret: webhook_secret,
    clientSecret: client_secret,
  }
}

/** One attempt: the code is single-use, so a retry after a slow reply finds it spent. */
async function convert(
  code: string,
): Promise<
  | { ok: true; app: Conversion }
  | { ok: false; code: 'conversion-failed' | 'conversion-timeout'; reason: string }
> {
  let res: Response
  let raw: unknown
  try {
    res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: GITHUB_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(CONVERSION_TIMEOUT_MS),
    })
    if (!res.ok) {
      return {
        ok: false,
        code: 'conversion-failed',
        reason: `GitHub answered the conversion with ${String(res.status)}.`,
      }
    }
    raw = await res.json()
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return timedOut
      ? {
          ok: false,
          code: 'conversion-timeout',
          reason: 'GitHub did not answer the conversion in 8 s.',
        }
      : { ok: false, code: 'conversion-failed', reason: 'The conversion reply could not be read.' }
  }
  const app = readConversion(raw)
  if (app === null) {
    return {
      ok: false,
      code: 'conversion-failed',
      reason: 'The conversion reply was missing a field.',
    }
  }
  const grant = grantError(raw)
  if (grant !== null) {
    return {
      ok: false,
      code: 'conversion-failed',
      reason: `${app.slug} was not registered as the manifest asked: ${grant}`,
    }
  }
  return { ok: true, app }
}

/**
 * Apply the sealed credentials beside the App's ids in site.json, refusing if
 * the committed site.json no longer names the App this one was created to
 * follow (`priorAppId`, null for none).
 */
async function applyApp(
  actor: string,
  ciphertext: string,
  app: SiteGithubApp,
  priorAppId: number | null,
): Promise<GithubAppApply> {
  // The committed document, not the Settings draft: runSecretApply refuses
  // while anything else is pending, so committed is exactly what stays.
  const site = await readCommittedSite()
  if (!site.present) {
    return { ok: false, reason: 'There is no committed site.json to record the App in.' }
  }
  const current = site.doc.github?.app?.id ?? null
  if (current !== priorAppId) {
    return {
      ok: false,
      reason:
        current === null
          ? `site.json no longer names the App ${app.slug} was created to replace (id ${String(priorAppId)}). Discard it and start again.`
          : `site.json now names another GitHub App (id ${String(current)}). Discard ${app.slug} and start again.`,
    }
  }
  const siteJson = renderSiteFile({ ...site.doc, github: { app } })
  try {
    const { runSecretApply } = await import('../../lib/apply-flow')
    const outcome = await runSecretApply(
      actor,
      { file: GITHUB_APP_FILE, name: VAULT_NAME, ciphertext },
      { extraFiles: { 'site.json': siteJson } },
    )
    return outcome.ok ? { ok: true, id: outcome.id } : { ok: false, reason: outcome.reason }
  } catch {
    return { ok: false, reason: 'The Apply could not be requested.' }
  }
}

// ── the finish lock ────────────────────────────────────────────────────────
//
// Read → compare → delete must not interleave between two callbacks in this
// one process, so finishing runs one at a time. On globalThis so a Vite
// re-evaluation does not open a second lock beside the first.
//
// A holder gets FINISH_LOCK_MS. A hung pg write or Apply request must not
// wedge every later callback, so after that a waiting caller takes the slot
// over; the old holder checks the slot before each side effect and, finding
// it gone, stops and reports `unknown` instead of acting on what it had.

export const FINISH_LOCK_MS = 120_000

type Hold = { takenAt: number; done: Promise<void>; release: () => void }

// The slot is read as `unknown` and shape-checked every time. globalThis
// outlives a Vite re-evaluation, so it can hold whatever an older version of
// this file left there: the first one kept a bare Promise under another key,
// and a loop that awaited that as if it were a hold never yielded the event
// loop again. Anything unrecognised is taken over, never waited on.
const lockSlot = globalThis as unknown as { daedalusGithubAppFinishHold?: unknown }

const isHold = (v: unknown): v is Hold =>
  isRecord(v) &&
  typeof v.takenAt === 'number' &&
  Number.isFinite(v.takenAt) &&
  v.done instanceof Promise &&
  typeof v.release === 'function'

async function acquireFinish(): Promise<Hold> {
  for (;;) {
    const held = lockSlot.daedalusGithubAppFinishHold
    const now = Date.now()
    if (!isHold(held) || now - held.takenAt >= FINISH_LOCK_MS) {
      let release: () => void = () => undefined
      const done = new Promise<void>((resolve) => {
        release = resolve
      })
      const hold: Hold = { takenAt: now, done, release }
      lockSlot.daedalusGithubAppFinishHold = hold
      return hold
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      held.done,
      new Promise<void>((resolve) => {
        // Bounded both ways: never a zero-delay spin, never longer than a
        // whole hold (a clock stepped backwards would otherwise stretch it).
        timer = setTimeout(
          resolve,
          Math.min(FINISH_LOCK_MS, Math.max(1, held.takenAt + FINISH_LOCK_MS - now)),
        )
      }),
    ])
    clearTimeout(timer)
  }
}

function releaseFinish(hold: Hold): void {
  if (lockSlot.daedalusGithubAppFinishHold === hold)
    lockSlot.daedalusGithubAppFinishHold = undefined
  hold.release()
}

const SUPERSEDED: GithubAppFinish = {
  outcome: 'failed',
  code: 'unknown',
  reason: 'held the finish lock past its time limit; a later callback took it over',
}

export async function finishAppCreation(
  ctx: Ctx,
  actor: string | null,
  code: string,
  state: string,
): Promise<GithubAppFinish> {
  const hold = await acquireFinish()
  try {
    return await finish(
      ctx,
      actor,
      code,
      state,
      () => lockSlot.daedalusGithubAppFinishHold === hold,
    )
  } finally {
    releaseFinish(hold)
  }
}

type FailCode = Exclude<GithubCallbackCode, 'apply-refused'>

async function finish(
  ctx: Ctx,
  actor: string | null,
  code: string,
  state: string,
  owns: () => boolean,
): Promise<GithubAppFinish> {
  // The code is what the page shows (as a fixed sentence); the reason is for
  // the server log only.
  const failed = (code: FailCode, reason: string): GithubAppFinish => ({
    outcome: 'failed',
    code,
    reason,
  })
  if (!enabled(ctx)) return failed('disabled', DISABLED_REASON)
  if (actor === null) return failed('other-actor', 'the callback carried no identity header')

  const { SETTING_KEYS } = await import('../../lib/repo/settings')

  // Compared before anything is consumed. A top-level GET carries the
  // operator's session across sites, so a forged callback reaches this line
  // as the operator; it must leave the real creation where it is.
  const record = await ctx.store.read(SETTING_KEYS.githubAppCreation, isCreation)
  if (record === undefined) {
    return failed('state-mismatch', 'no creation record: never started, or already used')
  }
  if (state === '' || state.length > 256 || !safeEqual(sha256(state), record.stateHash)) {
    return failed('state-mismatch', 'the state hash does not match the creation record')
  }
  if (record.actor !== actor) {
    return failed('other-actor', `started by ${record.actor}, answered by ${actor}`)
  }
  if (Date.now() >= record.expiresAt) {
    return failed('state-expired', `expired at ${new Date(record.expiresAt).toISOString()}`)
  }

  // A match, and only a match, consumes it: single-use because this runs
  // under the finish lock, and consumed before the code is exchanged.
  if (!owns()) return SUPERSEDED
  await ctx.store.delete(SETTING_KEYS.githubAppCreation)

  if (!CODE_SHAPE.test(code)) return failed('conversion-failed', 'GitHub sent no usable code')

  const site = await readCommittedSite()
  const existing = site.present ? (site.doc.github?.app ?? null) : null
  if (existing !== null && !record.replace) {
    return failed('already-created', `site.json already names ${existing.slug}`)
  }
  const priorAppId = existing?.id ?? null

  if (!owns()) return SUPERSEDED
  const converted = await convert(code)
  if (!converted.ok) return failed(converted.code, converted.reason)
  const c = converted.app

  if (c.ownerId !== record.ownerId) {
    return failed(
      'owner-mismatch',
      `GitHub created ${c.slug} under ${c.owner} (${String(c.ownerId)}), expected ${String(record.ownerId)}`,
    )
  }
  if (pemError(c.pem) !== null) {
    return failed('conversion-failed', `the reply for ${c.slug} carried no usable private key`)
  }

  const sealed = await sealJsonForVault(GITHUB_APP_FILE, {
    pem: sealablePem(c.pem),
    webhookSecret: c.webhookSecret,
    clientSecret: c.clientSecret,
  })
  if (!sealed.ok) return failed('seal-failed', `${c.slug}: ${sealed.reason}`)

  const app: SiteGithubApp = {
    id: c.id,
    slug: c.slug,
    clientId: c.clientId,
    htmlUrl: c.htmlUrl,
    owner: c.owner,
    ownerId: c.ownerId,
  }
  if (!owns()) return SUPERSEDED
  const applied = await applyApp(actor, sealed.ciphertext, app, priorAppId)
  if (applied.ok) {
    await ctx.store.delete(SETTING_KEYS.githubAppPendingApply)
    return { outcome: 'created', id: applied.id }
  }

  if (!owns()) return SUPERSEDED
  const pending: PendingApply = {
    ciphertext: sealed.ciphertext,
    github: app,
    at: new Date().toISOString(),
    reason: applied.reason,
    replace: record.replace,
    priorAppId,
  }
  await ctx.store.write(SETTING_KEYS.githubAppPendingApply, pending)
  return { outcome: 'pending', code: 'apply-refused', reason: applied.reason }
}

// ── retry, discard, paste ──────────────────────────────────────────────────

export async function retryPendingApply(ctx: Ctx, actor: string | null): Promise<GithubAppApply> {
  if (!enabled(ctx)) return { ok: false, reason: DISABLED_REASON }
  if (actor === null) return { ok: false, reason: NO_ACTOR_REASON }
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  const pending = await ctx.store.read(SETTING_KEYS.githubAppPendingApply, isPendingApply)
  if (pending === undefined) return { ok: false, reason: 'No created App is waiting for an Apply.' }

  const applied = await applyApp(actor, pending.ciphertext, pending.github, pending.priorAppId)
  if (applied.ok) {
    await ctx.store.delete(SETTING_KEYS.githubAppPendingApply)
  } else {
    await ctx.store.write(SETTING_KEYS.githubAppPendingApply, {
      ...pending,
      reason: applied.reason,
    })
  }
  return applied
}

/**
 * Forget a created App's pending Apply: the ciphertext goes, and with it any
 * way for the box to use that App. The App itself stays on GitHub until the
 * operator deletes it there, which the page says.
 */
export async function discardPendingApply(
  ctx: Ctx,
  actor: string | null,
): Promise<GithubAppDiscard> {
  if (!enabled(ctx)) return { ok: false, reason: DISABLED_REASON }
  if (actor === null) return { ok: false, reason: NO_ACTOR_REASON }
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  const pending = await ctx.store.read(SETTING_KEYS.githubAppPendingApply, isPendingApply)
  if (pending === undefined) return { ok: false, reason: 'No created App is waiting for an Apply.' }
  await ctx.store.delete(SETTING_KEYS.githubAppPendingApply)
  console.info(
    `[github-app] ${actor} discarded the pending Apply for ${pending.github.slug} (App ${String(pending.github.id)})`,
  )
  return { ok: true, slug: pending.github.slug, htmlUrl: pending.github.htmlUrl }
}

/**
 * A new private key for the App site.json already names. The vault file holds
 * all three values and this container cannot read the old ones back, so the
 * webhook secret and client secret are replaced in the same Apply.
 */
export async function pasteAppKey(
  ctx: Ctx,
  actor: string | null,
  input: { pem: string; webhookSecret: string; clientSecret: string },
): Promise<GithubAppApply> {
  const refuse = (reason: string): GithubAppApply => ({ ok: false, reason })
  if (!enabled(ctx)) return refuse(DISABLED_REASON)
  if (actor === null) return refuse(NO_ACTOR_REASON)

  const site = await readCommittedSite()
  const app = site.present ? (site.doc.github?.app ?? null) : null
  if (app === null) return refuse('There is no GitHub App in site.json to give a key to.')
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  if ((await ctx.store.read(SETTING_KEYS.githubAppPendingApply, isPendingApply)) !== undefined) {
    return refuse('A created App is still waiting for its Apply. Retry or discard that first.')
  }

  const problem =
    pemError(input.pem) ??
    secretError('webhook secret', input.webhookSecret) ??
    secretError('client secret', input.clientSecret)
  if (problem !== null) return refuse(problem)

  const sealed = await sealJsonForVault(GITHUB_APP_FILE, {
    pem: sealablePem(input.pem),
    webhookSecret: input.webhookSecret,
    clientSecret: input.clientSecret,
  })
  if (!sealed.ok) return refuse(sealed.reason)

  try {
    const { runSecretApply } = await import('../../lib/apply-flow')
    const outcome = await runSecretApply(actor, {
      file: GITHUB_APP_FILE,
      name: VAULT_NAME,
      ciphertext: sealed.ciphertext,
    })
    return outcome.ok ? { ok: true, id: outcome.id } : refuse(outcome.reason)
  } catch {
    return refuse('The Apply could not be requested.')
  }
}

// ── status ─────────────────────────────────────────────────────────────────

export async function githubAppStatus(ctx: Ctx): Promise<GithubAppStatus> {
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  const [site, pending, snapshot] = await Promise.all([
    readCommittedSite(),
    // An unreadable store costs the pending banner, not the tab.
    ctx.store.read(SETTING_KEYS.githubAppPendingApply, isPendingApply).catch(() => undefined),
    installationState(ctx),
  ])
  const identity = site.present ? (site.doc.github?.app ?? null) : null
  const installation = snapshot.available
    ? { ...publicInstallation(snapshot.data), stale: snapshot.stale }
    : undefined

  let state: GithubAppState = 'none'
  if (pending !== undefined) state = 'pending-apply'
  else if (identity !== null) {
    const account = installation?.state === 'ok' ? installation.account : null
    state =
      account === null
        ? 'created'
        : account.id === identity.ownerId
          ? 'installed'
          : 'installed-elsewhere'
  }

  return {
    enabled: enabled(ctx),
    state,
    owner: OWNER,
    defaultName: defaultAppName(site.present ? site.doc.identity.baseDomain : BASE_DOMAIN),
    nameMax: APP_NAME_MAX,
    // Where an orphaned App is deleted. A user's list; site.json does not say
    // whether the owner is an organization, whose list lives elsewhere.
    appsUrl: 'https://github.com/settings/apps',
    ...(identity === null
      ? {}
      : {
          identity,
          installUrl: installUrl(identity.slug),
          settingsUrl: `https://github.com/settings/apps/${encodeURIComponent(identity.slug)}`,
        }),
    ...(installation === undefined ? {} : { installation }),
    ...(pending === undefined
      ? {}
      : {
          pending: {
            slug: pending.github.slug,
            htmlUrl: pending.github.htmlUrl,
            at: pending.at,
            reason: pending.reason,
          },
        }),
  }
}

// ── the callback's answer ──────────────────────────────────────────────────

const REASON_MAX = 240

/** One line, no control characters, short enough for a log line. */
export function shortReason(reason: string): string {
  const flat = reason
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length <= REASON_MAX ? flat : `${flat.slice(0, REASON_MAX - 1)}…`
}

/**
 * Relative on purpose: never built from the request's own URL or forwarded
 * headers. `reason` is a code from a fixed set, never text: the page maps it
 * to its own sentence, so a crafted link cannot put words on it.
 */
export function callbackLocation(result: GithubAppFinish): string {
  const base = `/settings?tab=integrations&github=${result.outcome}`
  return result.outcome === 'created' ? base : `${base}&reason=${result.code}`
}

export function callbackResponse(result: GithubAppFinish): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: callbackLocation(result),
      'Cache-Control': 'no-store',
      // The URL that reached here carried the code and the state.
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/** GET /settings/github/callback?code&state, behind the gate like every page. */
export async function githubCallback(ctx: Ctx, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const actor = actorFrom(request.headers.get('x-forwarded-email'))
  const code = params.get('code') ?? ''
  const state = params.get('state') ?? ''
  // Neither the code nor the state reaches a log line, even inside an error.
  const scrub = (text: string) =>
    [code, state]
      .filter((s) => s.length >= 8)
      .reduce((acc, s) => acc.replaceAll(s, '[redacted]'), shortReason(text))

  let result: GithubAppFinish
  try {
    result = await finishAppCreation(ctx, actor, code, state)
  } catch (e) {
    result = {
      outcome: 'failed',
      code: 'unknown',
      reason: e instanceof Error ? `${e.name}: ${e.message}` : 'non-Error thrown',
    }
  }

  const who = actor ?? '(no identity)'
  if (result.outcome === 'created') {
    console.info(`[github-app] callback created; apply ${result.id} requested by ${who}`)
  } else {
    console.warn(
      `[github-app] callback ${result.outcome} (${result.code}) for ${who}: ${scrub(result.reason)}`,
    )
  }
  return callbackResponse(result)
}
