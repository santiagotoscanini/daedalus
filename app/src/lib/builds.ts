import { stripAnsi } from './ansi'
import {
  arrayOf,
  bool,
  DecodeError,
  type Decoder,
  literal,
  nullable,
  num,
  obj,
  optional,
  recordOf,
  str,
} from './contract/decode'

// The `build` bridge verb: what this container asks the host builder to do,
// and what the host says back. Client-safe on purpose — the build page renders
// statuses and log tails in the browser. The file half (writing the request,
// reading the status and the log) is lib/build-bridge.ts.
//
// The request id is the builds row id, not a bridge-minted one: the host names
// the log `<id>.log` and stamps the status with it, and the queue matches the
// status back to its row by that id. So this verb does not go through
// defineBridge, whose request() mints its own.

export const BUILD_REQUEST_FILE = 'build-request.json'
export const BUILD_STATUS_FILE = 'build-status.json'

/**
 * A running build's status must be rewritten at least this often. The host
 * heartbeats it during long phases; past this age the run is presumed dead.
 */
export const BUILD_STATUS_MAX_AGE_MS = 90_000

/** Also the log file's stem, so nothing a request carries can name a path. */
export const BUILD_ID_RE = /^[0-9a-fA-F-]{1,64}$/
export const BUILD_SHA_RE = /^[0-9a-f]{40}$/
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export const BUILD_STRATEGIES = ['auto', 'railpack', 'dockerfile'] as const
export const BUILD_PUBLISH_MODES = ['live', 'candidate'] as const
export const BUILD_REQUESTERS = ['webhook', 'sweep', 'operator'] as const
export const BUILD_STATES = [
  'queued',
  'cloning',
  'detecting',
  'checking',
  'building',
  'publishing',
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
] as const

export type BuildStrategy = (typeof BUILD_STRATEGIES)[number]
export type BuildPublish = (typeof BUILD_PUBLISH_MODES)[number]
export type BuildRequester = (typeof BUILD_REQUESTERS)[number]
export type BuildState = (typeof BUILD_STATES)[number]

/** Handed to the host and not yet finished. `queued` is not one: nothing has started. */
export const ACTIVE_BUILD_STATES: readonly BuildState[] = [
  'cloning',
  'detecting',
  'checking',
  'building',
  'publishing',
]
export const TERMINAL_BUILD_STATES: readonly BuildState[] = [
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
]

export const isActiveBuildState = (s: BuildState): boolean => ACTIVE_BUILD_STATES.includes(s)
export const isTerminalBuildState = (s: BuildState): boolean => TERMINAL_BUILD_STATES.includes(s)

export type BuildRequest = {
  version: 1
  id: string
  app: string
  sha: string
  repoId: number
  strategy: BuildStrategy
  publish: BuildPublish
  requestedBy: BuildRequester
  at: string
}

export type BuildChecks = {
  /** The check scripts that ran, in order. */
  ran: string[]
  /** The one that failed, when one did. */
  failed: string | null
}

export type BuildStatus = {
  version: 1
  id: string
  app: string
  sha: string
  state: BuildState
  phase: string
  /** What the host resolved `auto` to; `auto` only before detection. */
  strategy: BuildStrategy
  /** The default branch's tip when it was not `sha` — set on `superseded`. */
  tip: string | null
  digest: string | null
  imageRef: string | null
  sizeBytes: number | null
  /** Built but not deployed, because the app is pinned. */
  pinned: boolean
  /** Published as `candidate-<sha>` only. */
  candidate: boolean
  /**
   * Railpack's own output, copied by the host: `{ info, plan }` (the two
   * `railpack prepare` files) or the bare info document. Kept undecoded here —
   * lib/build-detect.ts reads it, tolerating Railpack's 0.x churn.
   */
  detected: unknown
  checks: BuildChecks | null
  /** Host words, already passed through redactBuildLog. */
  error: string | null
  /** Milliseconds per phase. */
  timings: Record<string, number>
  updatedAt: string
}

/** No status file: nothing has ever been built from here. */
export const NO_BUILD: BuildStatus | null = null

// ── decoders ────────────────────────────────────────────────────────────────

const versionOne: Decoder<1> = (v, p) => {
  if (v !== 1) {
    throw new DecodeError(p, `unsupported version ${typeof v === 'number' ? String(v) : typeof v}`)
  }
  return 1
}

function matching(re: RegExp, what: string): Decoder<string> {
  return (v, p) => {
    const s = str(v, p)
    if (!re.test(s)) throw new DecodeError(p, `expected ${what}`)
    return s
  }
}

const repoId: Decoder<number> = (v, p) => {
  const n = num(v, p)
  if (!Number.isSafeInteger(n) || n <= 0) throw new DecodeError(p, 'expected a positive integer')
  return n
}

const unknownValue: Decoder<unknown> = (v) => v

const redacted: Decoder<string> = (v, p) => redactBuildLog(str(v, p))

export const buildRequestDecoder: Decoder<BuildRequest> = obj({
  version: versionOne,
  id: matching(BUILD_ID_RE, 'a build id'),
  app: matching(APP_NAME_RE, 'an app name'),
  sha: matching(BUILD_SHA_RE, 'a 40-hex commit sha'),
  repoId,
  strategy: literal(...BUILD_STRATEGIES),
  publish: literal(...BUILD_PUBLISH_MODES),
  requestedBy: literal(...BUILD_REQUESTERS),
  at: str,
})

export const buildStatusDecoder: Decoder<BuildStatus> = obj({
  version: versionOne,
  id: matching(BUILD_ID_RE, 'a build id'),
  app: str,
  sha: str,
  state: literal(...BUILD_STATES),
  phase: optional(str, ''),
  strategy: optional(literal(...BUILD_STRATEGIES), 'auto'),
  tip: optional(nullable(matching(BUILD_SHA_RE, 'a 40-hex commit sha')), null),
  digest: optional(nullable(str), null),
  imageRef: optional(nullable(str), null),
  sizeBytes: optional(nullable(num), null),
  pinned: optional(bool, false),
  candidate: optional(bool, false),
  detected: optional(unknownValue, null),
  checks: optional(
    nullable(obj({ ran: optional(arrayOf(str), []), failed: optional(nullable(str), null) })),
    null,
  ),
  error: optional(nullable(redacted), null),
  timings: optional(recordOf(num), {}),
  updatedAt: str,
})

/** Builds and validates a request; throws DecodeError naming the bad field. */
export function buildRequest(
  input: Omit<BuildRequest, 'version' | 'at'> & { at: Date },
): BuildRequest {
  return buildRequestDecoder({ ...input, version: 1, at: input.at.toISOString() }, '')
}

// ── logs ────────────────────────────────────────────────────────────────────

export type EnvReader = (name: string) => string | undefined

export const DEFAULT_BUILD_LOGS_PATH = '/builds'

/** Where a build's log lives, or null for an id that could name anything else. */
export function buildLogPath(id: string, env: EnvReader): string | null {
  if (!BUILD_ID_RE.test(id)) return null
  const dir = (env('BUILD_LOGS_PATH') ?? DEFAULT_BUILD_LOGS_PATH).replace(/\/+$/, '')
  return `${dir}/${id}.log`
}

/**
 * The bytes read from a log's end, as text. When the read did not start at the
 * file's beginning, everything up to the first newline is dropped: that line
 * is partial, and a secret cut in half by the read would no longer match the
 * redaction patterns that recognise it by its prefix.
 */
export function tailFromBytes(bytes: Uint8Array, cutAtStart: boolean): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (!cutAtStart) return text
  const nl = text.indexOf('\n')
  return nl === -1 ? '' : text.slice(nl + 1)
}

const REDACTED = '[redacted]'

// A private key block, PEM or PGP armour: BEGIN to END, or to the end of the
// text when END has not been written yet.
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g
// A key whose BEGIN line fell before a tail's start: everything up to its END.
const PEM_ORPHAN_END = /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/

// Every pattern runs over a log of up to a MiB on the event loop, so each must
// stay linear on hostile input: it starts at a literal or behind a lookbehind
// that refuses a start inside a run it would rescan, and no two unbounded
// quantifiers in it can trade characters.
const TOKEN_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]+/g, REDACTED],
  [/gh[opusr]_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/x-access-token:[^@\s]+/g, `x-access-token:${REDACTED}`],
  [/x-access-token%3A[^@%\s]+/gi, `x-access-token%3A${REDACTED}`],
  // scheme://user:secret@ — the scheme and user stay. The secret runs to the
  // last @ before a slash or a space, so an unencoded @ in it does not leak.
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s/]+@/gi, `$1${REDACTED}@`],
  // A Docker config.json credential.
  [/("auth"\s*:\s*")[A-Za-z0-9+/=]+"/g, `$1${REDACTED}"`],
  // A header as curl, git and JSON (plain or escaped inside a string) print it.
  [
    /(authorization\\?["']?\s*[:=]\s*(?:\\?["'])?(?:basic|bearer|token)\s+)[^\s"'\\,;]+/gi,
    `$1${REDACTED}`,
  ],
  // An .npmrc registry credential.
  [/(_authToken\s*=\s*["']?)[^\s"']+/gi, `$1${REDACTED}`],
]

/**
 * The second redaction layer: the host filters the log as it writes, and
 * everything leaving this server passes through here again. Patterns only —
 * no knowledge of the real values, so it also catches a token the host never
 * knew it printed.
 *
 * Terminal escapes are stripped first, and stay stripped: a colour code in the
 * middle of a token would otherwise end the pattern's run before the secret
 * does.
 */
export function redactBuildLog(text: string): string {
  let out = stripAnsi(text).replace(PEM_BLOCK, REDACTED).replace(PEM_ORPHAN_END, REDACTED)
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement)
  return out
}
