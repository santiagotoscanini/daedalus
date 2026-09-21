import { isRecord } from './is-record'
import type { Result } from './result'

// A `Result` as an HTTP response, and back.
//
// The scriptable doors (routes/api.registry.apply.ts, routes/api.image-update.ts)
// answer in one dialect, which this file names so that something other than a
// person reading curl output can decode it:
//
//   2xx  { "status": "queued", …the value's own fields }
//   4xx/5xx  { "status": "<code>", "reason": "<sentence>" }
//
// `status` in the body is the refusal's CODE (`busy`, `noop`, `refused`), which
// is finer than the HTTP status beside it: three different refusals are all a
// 409, and a script branches on the word.
//
// NOT every `api.*` route speaks this, and the ones that do not are not to be
// converted: /api/deploy answers zot with `{status:"error", error}` and
// /api/github/webhook answers GitHub with `{error}`. Those bodies are read by
// senders this repo does not own (and by the delivery log a person debugs
// from), so their wire format is fixed where it stands.

/** Why a request was not carried out, as the class of HTTP status it earns. */
export type RefusalKind = 'unauthenticated' | 'forbidden' | 'bad-input' | 'conflict' | 'upstream'

export const REFUSAL_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  'bad-input': 400,
  /** Also "one is already in flight": the request was fine and the box is not free. */
  conflict: 409,
  /** The host agent, or a service behind it, failed; the request itself was fine. */
  upstream: 502,
} as const satisfies Record<RefusalKind, number>

/** A refusal with the word a script branches on beside the sentence a person reads. */
export type Refusal<C extends string = string> = { code: C; reason: string }

export type HttpRefusalBody<C extends string = string> = { status: C; reason: string }

/** `queued` for work handed to the host and polled for; `ok` for work that is finished. */
export type AcceptedLabel = 'queued' | 'ok'

export type HttpAcceptedBody<T extends object, L extends AcceptedLabel = 'queued'> = {
  status: L
} & T

/** The body either way — what a caller of these routes decodes. */
export type HttpResultBody<
  T extends object,
  C extends string = string,
  L extends AcceptedLabel = 'queued',
> = HttpAcceptedBody<T, L> | HttpRefusalBody<C>

export function refusalResponse<C extends string>(
  kind: RefusalKind,
  refusal: Refusal<C>,
): Response {
  const body: HttpRefusalBody<C> = { status: refusal.code, reason: refusal.reason }
  return Response.json(body, { status: REFUSAL_STATUS[kind] })
}

/**
 * The response for a `Result`. `kind` classifies each refusal code, and is a
 * total function over `C` on purpose: a flow that grows a code fails to
 * compile here until somebody decides what status it is.
 *
 * The value's fields are spread beside `status`, so a value must not carry a
 * `status` of its own — the type refuses one.
 */
export function httpResult<
  T extends object & { status?: never },
  C extends string,
  L extends AcceptedLabel = 'queued',
>(
  result: Result<T, Refusal<C>>,
  opts: {
    kind: (code: C) => RefusalKind
    accepted?: L
    /** 202 when the caller should know the work has only been accepted. 200 by default. */
    okStatus?: 200 | 202
  },
): Response {
  if (!result.ok) return refusalResponse(opts.kind(result.reason.code), result.reason)
  const body = { status: opts.accepted ?? 'queued', ...result.value } as HttpAcceptedBody<T, L>
  return Response.json(body, { status: opts.okStatus ?? 200 })
}

/**
 * The inverse, for a caller holding a fetched response: the MCP server's
 * tests, a CLI. Decided by the HTTP status, not by guessing at the body — a
 * refusal code and an accepted label are both just a word under `status`.
 *
 * Throws on a body that is not this dialect at all (an HTML 500, a proxy's
 * error page): per lib/result.ts that is not an answer, it is a broken call.
 */
export async function readHttpResult<T extends object, C extends string = string>(
  response: Response,
): Promise<Result<T, Refusal<C> & { httpStatus: number }>> {
  const body: unknown = await response.json()
  if (!isRecord(body) || typeof body.status !== 'string') {
    throw new Error(`HTTP ${String(response.status)}: not a result body`)
  }
  if (response.ok) {
    const { status: _label, ...value } = body
    return { ok: true, value: value as T }
  }
  if (typeof body.reason !== 'string') {
    throw new Error(`HTTP ${String(response.status)}: a refusal without a reason`)
  }
  return {
    ok: false,
    reason: { code: body.status as C, reason: body.reason, httpStatus: response.status },
  }
}

/**
 * A request's JSON body, if it is an object.
 *
 * `null` is valid JSON: the parse succeeds, a catch never fires, and a cast to
 * a record would leave the first property read to throw outside the try — a
 * 500 where a 400 is meant. The two failures stay apart because the routes
 * word them differently, and their wording is wire format.
 */
export async function readJsonObject(
  request: Request,
): Promise<Result<Record<string, unknown>, 'not-json' | 'not-object'>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'not-object' }
}
