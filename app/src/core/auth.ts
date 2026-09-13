import { getRequestHeader } from '@tanstack/react-start/server'

// Who is making this request.
//
// There is exactly one source of identity in this app: `X-Forwarded-Email`,
// set by traefik's forward-auth middleware after Pocket ID (auth.headers in
// stacks/daedalus/daedalus.nix). Nothing else authenticates anybody — the
// container itself is not reachable except through that gate.
//
// One header, but two completely different questions asked of it, and they
// used to be written out at twenty call sites in three dialects:
//
//   "who should this record say did it"  — a LABEL. Never fails; an absent
//   header is a placeholder, because a commit message or a journal line has
//   to say something. `actorLabel`.
//
//   "is anyone signed in at all"         — a GATE. An absent header is a
//   refusal, and a blank one must not match another blank one as the same
//   person. `requireActor`.
//
// The gate lived in core/settings/github-app.ts, 878 lines about GitHub Apps,
// which is where nobody would look for the app's only signed-in-identity
// predicate. Reviewing what is gated and what is merely labelled now means
// reading the imports at the top of a file.
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
 * spreading it over three files is how a third spelling appeared last time.
 */
export const AUTH_HEADERS = {
  EMAIL: 'x-forwarded-email',
  SUBJECT: 'x-forwarded-user',
} as const

const HEADER: string = AUTH_HEADERS.EMAIL

/** What a record says when the request carried no identity to name. */
export const UNKNOWN_ACTOR = 'unknown operator'

/** The one sentence every gated action answers with when the gate is empty. */
export const NO_ACTOR_REASON = 'The request carried no signed-in identity, so nothing was done.'

/** A signed-in operator, or the refusal to hand back. */
export type Actor = { ok: true; actor: string } | { ok: false; reason: string }

const gate = (header: string | null | undefined): Actor => {
  const v = header?.trim() ?? ''
  return v === '' ? { ok: false, reason: NO_ACTOR_REASON } : { ok: true, actor: v }
}

/**
 * The gate, over a request a caller is holding — the `api.*` route handlers
 * and the GitHub callback, which are given one rather than running inside it.
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
export const actorOrNull = (a: Actor): string | null => (a.ok ? a.actor : null)

const label = (header: string | null | undefined, fallback: string): string => header ?? fallback

/**
 * The display label, over a request a caller is holding. Never fails.
 *
 * The `api.*` routes pass their own fallback — a request that reaches
 * /api/deploy is normally zot's, and "registry" is truer than "unknown
 * operator" for it.
 *
 * Only absence falls back: a header present and blank labels the record with a
 * blank, as it always has. That is the asymmetry with the gate above, and it is
 * kept rather than fixed — tightening it would change what a record says about
 * who wrote it, which is a different change from this one.
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
