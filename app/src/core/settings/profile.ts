import { webAppHosts } from '../../lib/nix-manifest'
import {
  lengthError,
  MAX_PICTURE_BYTES,
  type PictureType,
  usernameError,
} from '../../lib/profile-fields'
import { mailAddressError } from '../../lib/site-fields'
import type { Ctx } from '../ctx'
import type { Profile, ProfilePatch, ProfileRead } from './types'

// Settings › Profile: the person behind the passkey, as Pocket ID knows them.
//
// Pocket ID is the source — the operator's call (2026-09-11). The name,
// username, email and picture already live on the IdP account every app signs
// in against, and every consent screen shows them, so there is exactly one
// copy and this page edits it. Reads and writes go through Pocket ID's admin
// API with the static API key (DASH_POCKETID_KEY), the sanctioned path for
// state that lives inside an app.
//
// WHICH account is decided by the forward-auth headers of the request, never
// by the page: X-Forwarded-User carries the OIDC `sub` (Pocket ID's user id,
// stable across a rename), X-Forwarded-Email the address, kept as the fallback
// for a session or a configuration older than the `sub` header. Nothing here
// takes an account id from the client, so a request can only ever reach the
// account it signed in as.
//
// One trap shapes the write. PUT /api/users/:id is the ADMIN update, and for
// an admin editing another account Pocket ID applies `isAdmin`, `disabled` and
// `emailVerified` straight from the body — its self-edit guard only covers
// PUT /api/users/me, which an API key cannot use. So every save re-sends those
// three exactly as read, and refuses to write at all if the read did not carry
// them: a missing boolean decodes as false, which would take the operator's
// admin rights (and every gated app with them) along with a name change.
// `userGroupIds` is left out; that endpoint ignores it.

/** Who a request signed in as, per the forward-auth headers traefik sets. */
export type Who = { sub: string | null; email: string | null }

type PocketUser = {
  id: string
  username: string
  email?: string | null
  emailVerified?: boolean
  firstName?: string
  lastName?: string
  displayName?: string
  isAdmin?: boolean
  locale?: string | null
  disabled?: boolean
  ldapId?: string | null
  userGroups?: { name?: string; friendlyName?: string }[]
}

type Call =
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; status: number | null; message: string }

// A new connection to a port published out of the rootless netns can stall on
// its SYN, so a THROWN attempt is retried on a rising budget; a 4xx/5xx is
// Pocket ID answering and is returned as it is. Every request here is safe to
// repeat — GETs, and a PUT or DELETE that replaces the whole thing.
const LADDER = [1_000, 2_500, 10_000]

async function pocketHost(): Promise<string | null> {
  return (await webAppHosts())['pocket-id'] ?? null
}

async function pocket(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Call> {
  const host = await pocketHost()
  if (host === null) {
    return { ok: false, status: null, message: 'Pocket ID is not published on this box.' }
  }
  const apiKey = ctx.secret('POCKETID_KEY')
  if (apiKey === '') {
    return {
      ok: false,
      status: null,
      message: 'No Pocket ID API key in this container. See daedalus-dashboard-keys.',
    }
  }
  for (const ms of LADDER) {
    try {
      const res = await fetch(`https://${host}${path}`, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(ms),
        headers: { ...(init.headers as Record<string, string> | undefined), 'X-API-KEY': apiKey },
      })
      // Read inside the attempt, so a body cut off by the timeout is retried
      // like a stalled connection rather than thrown at the caller.
      const bytes = await res.arrayBuffer()
      if (res.ok) {
        return { ok: true, bytes, contentType: res.headers.get('content-type') ?? '' }
      }
      return { ok: false, status: res.status, message: errorOf(bytes, res.status) }
    } catch {
      // the next, longer attempt; the last one reports no answer
    }
  }
  return { ok: false, status: null, message: 'Pocket ID did not answer.' }
}

function errorOf(bytes: ArrayBuffer, status: number): string {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown }
    if (typeof body.error === 'string' && body.error !== '') return `Pocket ID: ${body.error}`
  } catch {
    // not JSON; fall through to the status
  }
  return `Pocket ID answered HTTP ${String(status)}.`
}

function json<T>(call: { bytes: ArrayBuffer }): T {
  return JSON.parse(new TextDecoder().decode(call.bytes)) as T
}

type Found = { ok: true; user: PocketUser } | { ok: false; reason: string }

async function findUser(ctx: Ctx, who: Who): Promise<Found> {
  if (who.sub === null && who.email === null) {
    return {
      ok: false,
      reason:
        'This request carries no signed-in identity, so it did not come through the Pocket ID gate.',
    }
  }
  if (who.sub !== null) {
    const r = await pocket(ctx, `/api/users/${encodeURIComponent(who.sub)}`)
    if (r.ok) return { ok: true, user: json<PocketUser>(r) }
    if (r.status !== 404) return { ok: false, reason: r.message }
  }
  if (who.email !== null) {
    const r = await pocket(ctx, '/api/users?pagination[limit]=100')
    if (!r.ok) return { ok: false, reason: r.message }
    const wanted = who.email.toLowerCase()
    const user = (json<{ data?: PocketUser[] }>(r).data ?? []).find(
      (u) => typeof u.email === 'string' && u.email.toLowerCase() === wanted,
    )
    if (user !== undefined) return { ok: true, user }
  }
  return { ok: false, reason: 'No Pocket ID account matches the signed-in identity.' }
}

const fromLdap = (u: PocketUser) => typeof u.ldapId === 'string' && u.ldapId !== ''

async function toProfile(u: PocketUser): Promise<Profile> {
  const host = await pocketHost()
  return {
    id: u.id,
    username: u.username,
    firstName: u.firstName ?? '',
    lastName: u.lastName ?? '',
    displayName: u.displayName ?? '',
    email: u.email ?? '',
    emailVerified: u.emailVerified === true,
    isAdmin: u.isAdmin === true,
    groups: (u.userGroups ?? [])
      .map((g) => g.friendlyName || g.name || '')
      .filter((g) => g !== '')
      .sort(),
    managedByLdap: fromLdap(u),
    accountUrl: host === null ? '' : `https://${host}/settings/account`,
  }
}

export async function readProfile(ctx: Ctx, who: Who): Promise<ProfileRead> {
  const found = await findUser(ctx, who)
  return found.ok ? { ok: true, profile: await toProfile(found.user) } : found
}

function checkPatch(patch: ProfilePatch): void {
  const checks: [string | undefined, (v: string) => string | null, string][] = [
    [patch.username, usernameError, 'Username'],
    [patch.firstName, lengthError(50), 'First name'],
    [patch.lastName, lengthError(50), 'Last name'],
    [patch.displayName, lengthError(100), 'Display name'],
    [patch.email, mailAddressError, 'Email'],
  ]
  for (const [value, check, label] of checks) {
    const problem = value === undefined ? null : check(value)
    if (problem !== null) throw new Error(`${label}: ${problem}`)
  }
}

export async function updateProfile(ctx: Ctx, who: Who, patch: ProfilePatch): Promise<ProfileRead> {
  checkPatch(patch)
  const found = await findUser(ctx, who)
  if (!found.ok) throw new Error(found.reason)
  const u = found.user
  if (fromLdap(u)) {
    throw new Error('This account is synced from LDAP; Pocket ID will not take edits to it.')
  }
  if (
    typeof u.isAdmin !== 'boolean' ||
    typeof u.disabled !== 'boolean' ||
    typeof u.emailVerified !== 'boolean'
  ) {
    throw new Error(
      'Pocket ID did not report isAdmin, disabled and emailVerified for this account, so the edit was not sent: writing it would reset them.',
    )
  }
  const text = (next: string | undefined, current: string | undefined) =>
    next === undefined ? (current ?? '') : next.trim()
  const body = {
    username: text(patch.username, u.username),
    email: patch.email === undefined ? (u.email ?? null) : patch.email.trim(),
    firstName: text(patch.firstName, u.firstName),
    lastName: text(patch.lastName, u.lastName),
    displayName: text(patch.displayName, u.displayName),
    locale: u.locale ?? null,
    // Re-sent exactly as read — see the header.
    isAdmin: u.isAdmin,
    disabled: u.disabled,
    emailVerified: u.emailVerified,
  }
  const r = await pocket(ctx, `/api/users/${encodeURIComponent(u.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(r.message)
  // By id from here: an email edit has just made the email header stale.
  return readProfile(ctx, { sub: u.id, email: null })
}

export async function uploadPicture(
  ctx: Ctx,
  who: Who,
  picture: { contentType: PictureType; base64: string },
): Promise<void> {
  const found = await findUser(ctx, who)
  if (!found.ok) throw new Error(found.reason)
  const bytes = new Uint8Array(Buffer.from(picture.base64, 'base64'))
  if (bytes.length === 0) throw new Error('The picture is empty.')
  if (bytes.length > MAX_PICTURE_BYTES) throw new Error('The picture is over 5 MB.')
  const form = new FormData()
  form.append(
    'file',
    new Blob([bytes], { type: picture.contentType }),
    picture.contentType === 'image/png' ? 'picture.png' : 'picture.jpg',
  )
  const r = await pocket(ctx, `/api/users/${encodeURIComponent(found.user.id)}/profile-picture`, {
    method: 'PUT',
    body: form,
  })
  if (!r.ok) throw new Error(r.message)
}

/** Back to Pocket ID's generated initials. */
export async function resetPicture(ctx: Ctx, who: Who): Promise<void> {
  const found = await findUser(ctx, who)
  if (!found.ok) throw new Error(found.reason)
  const r = await pocket(ctx, `/api/users/${encodeURIComponent(found.user.id)}/profile-picture`, {
    method: 'DELETE',
  })
  if (!r.ok) throw new Error(r.message)
}

/** The picture's bytes, or null when there is no account to show one for. */
export async function profilePicture(
  ctx: Ctx,
  who: Who,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const found = await findUser(ctx, who)
  if (!found.ok) return null
  const r = await pocket(ctx, `/api/users/${encodeURIComponent(found.user.id)}/profile-picture.png`)
  return r.ok ? { bytes: r.bytes, contentType: r.contentType || 'image/png' } : null
}
