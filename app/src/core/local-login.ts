import { createHash, randomBytes } from 'node:crypto'
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'
import {
  getCookie,
  getRequestProtocol,
  // h3's session manager, not a React hook — aliased so the hooks lint rule
  // does not read it as one.
  useSession as sessionManager,
  unsealSession,
} from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'
import { readCommittedSite } from '../host/contract/domains/site-doc'
import { db } from '../host/db'
import { safeEqual } from '../host/github-app-crypto'
import { localAdmins } from '../host/schema'
import { cookieValue } from '../lib/cookie'
import { isRecord } from '../lib/is-record'
import { deleteSetting, readSetting, SETTING_KEYS, writeSetting } from '../lib/repo/settings'
import type { Result } from '../lib/result'

// The break-glass local login: a password door into the control plane, for
// the day the IdP is down and for the first hour of a fresh install before an
// IdP exists.
//
// ── DORMANT BY CONSTRUCTION ───────────────────────────────────────────────
//
// Every function here asks `store.enabled()` first, and that reads ONE fact:
// site.json's `auth.localLogin`. When it is absent or false — which it is on
// this box — this module does nothing observable: the login route answers
// 404 (not a disabled form), no cookie is read, no row is touched, no token
// is minted. The flag is deliberately not a stored preference and not in
// core/site's EDITABLE list: a door into the control plane must not be
// openable from inside the control plane. It is a hand edit and a commit, or
// the onboarding wizard on a box that has nothing else yet.
//
// ── THE THREE SECRETS, and where each lives ───────────────────────────────
//
//   the setup token   — minted by THIS PROCESS at first start when the login
//                       is on and no admin exists, printed to the journal
//                       once, stored as a SHA-256 digest with a 24h expiry
//                       (settings `auth.localSetupToken`), and deleted the
//                       moment the first admin is created. It is never
//                       printed again after that: an admin exists, so there
//                       is nothing left for it to authorise.
//   the password      — argon2id, PHC string in `local_admins.password_hash`.
//                       A real password hash, unlike the MCP tokens' SHA-256,
//                       because a person chose this one.
//   the session seal  — the secret the cookie is sealed with, generated once
//                       (settings `auth.localSessionSecret`). Deleting the row
//                       signs every local session out.
//
// ── ONE ACTOR TYPE ────────────────────────────────────────────────────────
//
// A local session yields `local:<username>` through the same `Authorization`
// core/authz.ts builds from the forward-auth headers, with `admins` implied,
// so `assertAdmin()` and every write below it cannot tell which door the
// operator came through — except by the `local:` prefix a record keeps, which
// is the one thing an audit wants to know.
//
// ── READS HAVE NO SIDE EFFECTS ────────────────────────────────────────────
//
// h3's `getSession`/`useSession` SET a cookie when the request carries none
// (it mints an empty session), so identifying a request must never go
// through them: a Set-Cookie on every header-less request would be a
// session nobody asked for. Reads unseal the raw cookie; only login and
// logout touch the session manager.
//
// The database, the file, the cookie and the clock arrive through a `store`
// so the rules can be asserted against a fake; `defaultStore()` is the real
// one and the only place this module names drizzle or h3.

/** The prefix every local actor carries, so a record says which door it came through. */
export const LOCAL_ACTOR_PREFIX = 'local:'

const SETUP_TOKEN_PREFIX = 'dsetup_'
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60_000
const SESSION_NAME = 'daedalus_local'
const SESSION_MAX_AGE_S = 12 * 60 * 60

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
export const PASSWORD_MIN = 12

/** The sentence a login refuses with. One sentence for every failure, on purpose. */
export const WRONG_CREDENTIALS = 'Wrong username or password.'

/** What a route answers with when the login is off: the route does not exist. */
export const LOCAL_LOGIN_OFF = 'local login is off'

const digest = (s: string): string => createHash('sha256').update(s).digest('hex')

// A real argon2id hash of nothing anyone knows, verified against when the
// username does not exist, so "no such user" costs the same as "wrong
// password" and the two cannot be told apart by timing.
const DUMMY_HASH_PROMISE: Promise<string> = argon2Hash(randomBytes(32).toString('base64url'))

// ── the store ──────────────────────────────────────────────────────────────

export type LocalAdminRow = { id: string; username: string; passwordHash: string }

export type LocalLoginStore = {
  /** site.json `auth.localLogin`. Everything else here is gated on it. */
  enabled(): Promise<boolean>
  admins: {
    any(): Promise<boolean>
    find(username: string): Promise<LocalAdminRow | null>
    insert(username: string, passwordHash: string): Promise<void>
    stampLogin(id: string): Promise<void>
  }
  settings: {
    read<T>(key: string, guard: (v: unknown) => v is T): Promise<T | undefined>
    write(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  session: {
    /** The username the request's cookie names, or null. Never sets a cookie. */
    read(): Promise<string | null>
    write(username: string): Promise<void>
    clear(): Promise<void>
  }
  log(line: string): void
  now(): number
}

type SessionData = { user?: string }

type SealConfig = Parameters<typeof sessionManager<SessionData>>[0]

const isSecretRow = (v: unknown): v is { secret: string } =>
  isRecord(v) && typeof v.secret === 'string' && v.secret.length >= 32

/**
 * The seal secret, generated on first use when `create` is set. A read path
 * passes false: no secret means no session could have been sealed, so the
 * answer is "nobody" without writing anything.
 */
async function sessionSecret(
  settings: LocalLoginStore['settings'],
  create: boolean,
): Promise<string | null> {
  const row = await settings.read(SETTING_KEYS.authLocalSessionSecret, isSecretRow)
  if (row !== undefined) return row.secret
  if (!create) return null
  const secret = randomBytes(32).toString('base64url')
  await settings.write(SETTING_KEYS.authLocalSessionSecret, { secret })
  return secret
}

const sealConfig = (password: string, secure: boolean): SealConfig => ({
  password,
  name: SESSION_NAME,
  maxAge: SESSION_MAX_AGE_S,
  cookie: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
  // The cookie is the only carrier: a header would let a bearer of the
  // sealed value replay it from anywhere, cookie policy or not.
  sessionHeader: false,
})

/**
 * The real store. `request` is for a route handler holding one — the cookie
 * is read from it rather than from the ambient request; writes still go
 * through the ambient session manager, which only login and logout use.
 */
export function defaultStore(request?: Request): LocalLoginStore {
  const settings = { read: readSetting, write: writeSetting, delete: deleteSetting }
  const secure = () => getRequestProtocol({ xForwardedProto: true }) === 'https'
  return {
    enabled: async () => {
      const site = await readCommittedSite()
      return site.ok && site.value.doc.auth?.localLogin === true
    },
    admins: {
      any: async () =>
        (await db.select({ id: localAdmins.id }).from(localAdmins).limit(1)).length > 0,
      find: async (username) => {
        const [row] = await db
          .select({
            id: localAdmins.id,
            username: localAdmins.username,
            passwordHash: localAdmins.passwordHash,
          })
          .from(localAdmins)
          .where(eq(localAdmins.username, username))
          .limit(1)
        return row ?? null
      },
      insert: async (username, passwordHash) => {
        await db.insert(localAdmins).values({ username, passwordHash })
      },
      stampLogin: async (id) => {
        await db.update(localAdmins).set({ lastLoginAt: new Date() }).where(eq(localAdmins.id, id))
      },
    },
    settings,
    session: {
      read: async () => {
        const sealed =
          request === undefined
            ? getCookie(SESSION_NAME)
            : cookieValue(request.headers.get('cookie'), SESSION_NAME)
        if (sealed === undefined || sealed === '') return null
        const secret = await sessionSecret(settings, false)
        if (secret === null) return null
        try {
          const s = await unsealSession(sealConfig(secret, secure()), sealed)
          const user = (s.data as SessionData | undefined)?.user
          return typeof user === 'string' && user !== '' ? user : null
        } catch {
          return null
        }
      },
      write: async (username) => {
        const secret = await sessionSecret(settings, true)
        if (secret === null) throw new Error('no session secret')
        const s = await sessionManager<SessionData>(sealConfig(secret, secure()))
        await s.update({ user: username })
      },
      clear: async () => {
        const secret = await sessionSecret(settings, false)
        if (secret === null) return
        const s = await sessionManager<SessionData>(sealConfig(secret, secure()))
        await s.clear()
      },
    },
    log: (line) => {
      console.log(line)
    },
    now: () => Date.now(),
  }
}

// ── reads ──────────────────────────────────────────────────────────────────

/** What the login page renders, or null: the route does not exist. */
export type LocalLoginState = {
  /** `setup` until the first admin exists; the form then asks for the token too. */
  mode: 'setup' | 'login'
  /** The local username this request is already signed in as, if any. */
  signedInAs: string | null
}

export async function localLoginState(
  store: LocalLoginStore = defaultStore(),
): Promise<LocalLoginState | null> {
  if (!(await store.enabled())) return null
  const [any, user] = await Promise.all([store.admins.any(), store.session.read()])
  return { mode: any ? 'login' : 'setup', signedInAs: user }
}

/** The identity a local session carries: what core/authz.ts folds into its decision. */
export type LocalIdentity = { actor: string; username: string }

/**
 * Who the request's local session names, or null. Null without reading the
 * cookie when the login is off, and null when the cookie names an admin that
 * no longer exists — a deleted row signs its sessions out.
 */
export async function localIdentity(
  store: LocalLoginStore = defaultStore(),
): Promise<LocalIdentity | null> {
  if (!(await store.enabled())) return null
  const username = await store.session.read()
  if (username === null) return null
  const row = await store.admins.find(username)
  if (row === null) return null
  return { actor: LOCAL_ACTOR_PREFIX + row.username, username: row.username }
}

/** The same, over a request a route handler is holding. */
export function localIdentityOf(request: Request): Promise<LocalIdentity | null> {
  return localIdentity(defaultStore(request))
}

// ── the setup token ────────────────────────────────────────────────────────

type SetupTokenRow = { digest: string; expiresAt: number }

const isSetupTokenRow = (v: unknown): v is SetupTokenRow =>
  isRecord(v) && typeof v.digest === 'string' && typeof v.expiresAt === 'number'

export type SetupAnnouncement = 'off' | 'admins-exist' | 'announced'

/**
 * Mint the setup token and print it to the journal — once per process, and
 * only while the login is on and no admin exists. `memo` is the per-process
 * guard; the real one lives on globalThis (below) so Vite's re-evaluation of
 * this module does not print a second token.
 */
export async function announceSetupToken(
  memo: { ran: boolean },
  store: LocalLoginStore = defaultStore(),
): Promise<SetupAnnouncement> {
  if (memo.ran) return 'off'
  memo.ran = true
  if (!(await store.enabled())) return 'off'
  if (await store.admins.any()) return 'admins-exist'
  const token = SETUP_TOKEN_PREFIX + randomBytes(24).toString('base64url')
  const row: SetupTokenRow = { digest: digest(token), expiresAt: store.now() + SETUP_TOKEN_TTL_MS }
  await store.settings.write(SETTING_KEYS.authLocalSetupToken, row)
  store.log(
    `[local-login] no local admin exists. Create the first one at /login with this setup token (valid 24h, shown once): ${token}`,
  )
  return 'announced'
}

const MEMO_KEY = 'daedalusLocalLoginSetupV1'

/** The per-process call: /api/healthz and the login page both make it. */
export function announceSetupTokenOnce(): Promise<SetupAnnouncement> {
  const g = globalThis as unknown as Record<string, unknown>
  const slot = g[MEMO_KEY]
  const memo =
    isRecord(slot) && typeof slot.ran === 'boolean' ? (slot as { ran: boolean }) : { ran: false }
  g[MEMO_KEY] = memo
  return announceSetupToken(memo)
}

// ── writes ─────────────────────────────────────────────────────────────────

const validUsername = (u: string): string | null =>
  USERNAME_RE.test(u)
    ? null
    : 'A username is 2–32 lowercase letters, digits, dots, dashes or underscores.'

const validPassword = (p: string): string | null =>
  p.length >= PASSWORD_MIN ? null : `A password is at least ${String(PASSWORD_MIN)} characters.`

/**
 * Create the first admin. Refused unless the login is on, no admin exists,
 * and the token matches the one this process (or an earlier one) printed —
 * in constant time, and only while it is fresh. Nothing is written on a
 * refusal; on success the token row is gone and the request is signed in.
 */
export async function createFirstAdmin(
  input: { token: string; username: string; password: string },
  store: LocalLoginStore = defaultStore(),
): Promise<Result<null>> {
  if (!(await store.enabled())) throw new Error(LOCAL_LOGIN_OFF)
  if (await store.admins.any()) {
    return { ok: false, reason: 'A local admin already exists. Sign in instead.' }
  }
  const row = await store.settings.read(SETTING_KEYS.authLocalSetupToken, isSetupTokenRow)
  const presented = input.token.trim()
  if (
    row === undefined ||
    presented === '' ||
    !safeEqual(digest(presented), row.digest) ||
    store.now() > row.expiresAt
  ) {
    return {
      ok: false,
      reason:
        'That setup token is wrong or has expired. The current one is in the journal of the last start.',
    }
  }
  const username = input.username.trim()
  const problem = validUsername(username) ?? validPassword(input.password)
  if (problem !== null) return { ok: false, reason: problem }

  await store.admins.insert(username, await argon2Hash(input.password))
  await store.settings.delete(SETTING_KEYS.authLocalSetupToken)
  await store.session.write(username)
  return { ok: true, value: null }
}

/**
 * Sign in. One sentence for every failure, and nothing written on one — not
 * a stamp, not a cookie. A missing user is verified against a dummy hash so
 * it costs what a wrong password costs.
 */
export async function verifyLocalLogin(
  input: { username: string; password: string },
  store: LocalLoginStore = defaultStore(),
): Promise<Result<null>> {
  if (!(await store.enabled())) throw new Error(LOCAL_LOGIN_OFF)
  const username = input.username.trim()
  const row = USERNAME_RE.test(username) ? await store.admins.find(username) : null
  const ok = await argon2Verify(row?.passwordHash ?? (await DUMMY_HASH_PROMISE), input.password)
  if (row === null || !ok) return { ok: false, reason: WRONG_CREDENTIALS }
  await store.admins.stampLogin(row.id)
  await store.session.write(row.username)
  return { ok: true, value: null }
}

/** Sign out. A no-op when the login is off: there is no session to end. */
export async function endLocalSession(store: LocalLoginStore = defaultStore()): Promise<void> {
  if (!(await store.enabled())) return
  await store.session.clear()
}
