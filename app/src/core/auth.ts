import { getRequestHeader } from '@tanstack/react-start/server'
import type { Result } from '../lib/result'
import { ADMIN_GROUP } from './auth-names'

// Who is making this request.
//
// There is exactly one source of identity in this app: `X-Forwarded-Email`,
// set by traefik's forward-auth middleware after Pocket ID (auth.headers in
// nix/stacks/daedalus/daedalus.nix). Nothing else authenticates a person —
// the container itself is not reachable except through that gate, and the
// break-glass local login (core/local-login.ts) is consulted only by
// core/authz.ts when the header is absent.
//
// One header, but two completely different questions asked of it:
//
//   "who should this record say did it"  — a LABEL. Never fails; an absent
//   header is a placeholder, because a commit message or a journal line has
//   to say something. `actorLabel`.
//
//   "is anyone signed in at all"         — a GATE. An absent header is a
//   refusal, and a blank one must not match another blank one as the same
//   person. `requireActor`.
//
// Reviewing what is gated and what is merely labelled means reading the
// imports at the top of a file.
//
// Both questions come in two forms: the ambient one (`getRequestHeader`, which
// reads the request the server function is running inside) and the `…Of(request)`
// one, for the `api.*` route handlers and the GitHub callback, which are handed
// a Request rather than running inside one.
//
// This file deliberately reads no file, opens no connection and knows nothing
// about roles: forward-auth already decided, and the box has one operator.

/**
 * What the forward-auth proxy sets, named here so the strings exist once.
 *
 * `EMAIL` answers "who is acting", which is this module's whole subject.
 * `SUBJECT` is the OIDC `sub` and is a different question — it identifies the
 * account at the IdP rather than the person named in a record, so the profile
 * lookup pairs the two and nothing else here uses it. It lives here anyway,
 * because "which headers does the gate in front of us set" is one fact, and
 * spelled in several files it drifts.
 */
export const AUTH_HEADERS = {
  EMAIL: 'x-forwarded-email',
  SUBJECT: 'x-forwarded-user',
  GROUPS: 'x-forwarded-groups',
} as const

const HEADER: string = AUTH_HEADERS.EMAIL

// Defined in a module with no server import, so a component can name the group.
export { ADMIN_GROUP }

/** The sentence a mutation answers with when the caller is signed in but not an admin. */
export const NOT_ADMIN_REASON = `Only members of the ${ADMIN_GROUP} group can change this box, so nothing was done.`

/**
 * How the groups header arrived, for the panel that decides whether arming
 * the check is safe. `groups` alone cannot say: an empty list is what every
 * failure degrades to, and "the proxy sent nothing" and "the proxy sent a
 * list that does not name admins" call for different fixes.
 *
 *   absent      — no header at all: the header is not configured in nix, or
 *                 the request came in under the gate (shotter dials the
 *                 container directly).
 *   blank       — present and empty: the strip middleware ran and the plugin
 *                 never re-set it, which is what a bypassed path looks like.
 *   unparseable — present, not a JSON array (a non-string entry is dropped,
 *                 not refused).
 *   list        — a JSON array, possibly empty, possibly without `admins`.
 */
export type GroupsHeader = 'absent' | 'blank' | 'unparseable' | 'list'

export type GroupsRead = { state: GroupsHeader; groups: string[] }

/**
 * The groups the forward-auth proxy says this session carries.
 *
 * The header is a JSON array, because Go renders a bare claim list as
 * `[admins family]` — neither JSON nor comma-separated — so daedalus.nix
 * pipes it through the plugin's own `mapToJsonArray`.
 *
 * Every failure is the empty list rather than a throw. An empty list can
 * never satisfy `isAdmin`, so every one of them degrades to "not an admin"
 * rather than to an error page.
 */
export function describeGroups(header: string | null | undefined): GroupsRead {
  if (header === null || header === undefined) return { state: 'absent', groups: [] }
  const raw = header.trim()
  if (raw === '') return { state: 'blank', groups: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { state: 'unparseable', groups: [] }
    return {
      state: 'list',
      groups: parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== ''),
    }
  } catch {
    return { state: 'unparseable', groups: [] }
  }
}

/** The header's arrival state and its groups, over the request this server function is in. */
export function requireGroupsHeader(): GroupsRead {
  return describeGroups(getRequestHeader(AUTH_HEADERS.GROUPS))
}

/** Whether a group list carries the one that may change this box. */
export const isAdmin = (groups: readonly string[]): boolean => groups.includes(ADMIN_GROUP)

/** What a record says when the request carried no identity to name. */
export const UNKNOWN_ACTOR = 'unknown operator'

/** The one sentence every gated action answers with when the gate is empty. */
export const NO_ACTOR_REASON = 'The request carried no signed-in identity, so nothing was done.'

/** A signed-in operator, or the refusal to hand back. */
export type Actor = Result<string>

const gate = (header: string | null | undefined): Actor => {
  const v = header?.trim() ?? ''
  return v === '' ? { ok: false, reason: NO_ACTOR_REASON } : { ok: true, value: v }
}

/**
 * The gate, over a request a caller is holding — the GitHub callback
 * (core/settings/github-app.ts), which is given one rather than running
 * inside it.
 *
 * Missing or blank is a refusal, never a placeholder: two requests without an
 * identity must not match each other as the same actor.
 */
export function actorOf(request: Request): Actor {
  return gate(request.headers.get(HEADER))
}

/** The gate, over the request this server function is running inside. */
export function requireActor(): Actor {
  return gate(getRequestHeader(HEADER))
}

/**
 * The gate's answer as the nullable actor the core mutations take.
 *
 * They check it themselves and shape their own refusal (github-app.ts), so
 * they want the null rather than this module's sentence.
 */
export const actorOrNull = (a: Actor): string | null => (a.ok ? a.value : null)

const label = (header: string | null | undefined, fallback: string): string => header ?? fallback

/**
 * The display label, over a request a caller is holding. Never fails.
 *
 * The `api.*` routes pass their own fallback — a request that reaches
 * /api/deploy is normally zot's, and "registry" is truer than "unknown
 * operator" for it.
 *
 * Only absence falls back: a header present and blank labels the record with a
 * blank. That is an asymmetry with the gate above, and a known one; closing it
 * is a change to what records say about who wrote them, not to who may act.
 */
export function actorLabelOf(request: Request, fallback: string = UNKNOWN_ACTOR): string {
  return label(request.headers.get(HEADER), fallback)
}

/**
 * The display label, over the request this server function is running inside.
 *
 * Deliberately NOT the gate: every caller writes the result into a commit
 * message, a request file or a journal line, and none of them refuses. A
 * caller that should refuse wants `requireActor`.
 */
export function actorLabel(fallback: string = UNKNOWN_ACTOR): string {
  return label(getRequestHeader(HEADER), fallback)
}
