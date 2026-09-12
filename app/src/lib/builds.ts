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

/**
 * The app's build-time env, from its `buildEnvPlaceholders` and `railpackEnv`
 * columns. The host exports both into the builder's process env and passes the
 * names — never the values — on argv, so a name is a strict env identifier.
 * Placeholders are not secrets, but they are not image config either.
 */
export type BuildEnv = {
  placeholders: Record<string, string>
  railpack: Record<string, string>
}

export type BuildEnvKind = keyof BuildEnv

// Every limit below is host/build.sh's own (its buildEnv jq check), so a
// request this decoder passes is one the host accepts.
export const BUILD_ENV_PLACEHOLDER_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
export const BUILD_ENV_RAILPACK_RE = /^RAILPACK_[A-Z0-9_]{1,55}$/
export const BUILD_ENV_VALUE_MAX = 512
export const BUILD_ENV_ENTRIES_MAX = 40
/** Both maps together, measured as the request's JSON carries them (buildEnvBytes). */
export const BUILD_ENV_MAX_BYTES = 32 * 1024
/** The largest request the engine writes; the host refuses one past 65,536 bytes. */
export const BUILD_REQUEST_MAX_BYTES = 60 * 1024

/**
 * Names a placeholder may not take, because the builder's own tools read them
 * rather than the app: the shell, git, mise, BuildKit, the dynamic loader, and
 * the package managers, whose variables can point an install at another
 * registry. host/build.sh RESERVED_ENV_RE holds the same list; change both.
 */
export const RESERVED_ENV_NAMES = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH',
  'BASHOPTS',
  'SHELLOPTS',
  'CDPATH',
  'GLOBIGNORE',
  'PS4',
  'UID',
  'EUID',
  'PPID',
  'SHLVL',
  'TMPDIR',
  'TZ',
  'LANG',
  'LANGUAGE',
  'TERM',
  'HOSTNAME',
  'GITHUB_TOKEN',
  'GODEBUG',
  'GOFLAGS',
  'GOTRACEBACK',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'FTP_PROXY',
  'DAEDALUS_TOKEN_FILE',
] as const

/** Prefixes a placeholder may not start with; see RESERVED_ENV_NAMES. */
export const RESERVED_ENV_PREFIXES = [
  'LD_',
  'BASH_FUNC_',
  'GIT_',
  'BUILDKIT_',
  'BUILDCTL_',
  'DOCKER_',
  'MISE_',
  'RAILPACK_',
  'XDG_',
  'LC_',
  'SSL_',
  'NIX_SSL_',
  'CURL_',
  'SYSTEMD_',
  'NPM_CONFIG_',
  'PNPM_',
  'COREPACK_',
  'YARN_',
  'BUN_',
  'NODE_',
] as const

export function isReservedEnvName(name: string): boolean {
  return (
    (RESERVED_ENV_NAMES as readonly string[]).includes(name) ||
    RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))
  )
}

type Knob = { ok: (value: string) => boolean; says: string }

const FLAG: Knob = { ok: (v) => /^(?:true|false|1|0)$/.test(v), says: 'true, false, 1 or 0' }
// Railpack splits a list on single spaces (core/app/environment.go).
const APT_PACKAGE = '[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?'
const APT_PACKAGES: Knob = {
  ok: (v) => new RegExp(`^${APT_PACKAGE}(?: ${APT_PACKAGE})*$`).test(v),
  says: 'Debian package names, one space apart',
}

/**
 * The Railpack switches (v0.39.0) this box passes on, with the values each may
 * take. Only switches that tune how Railpack builds: every `*_CMD`, the config
 * file and the install patterns change what runs, and that belongs in the
 * repo's railpack.json, where it is reviewed with the code. RAILPACK_PACKAGES
 * is left out too: a mise package can name a backend that runs its own install
 * code, and `railpack prepare` resolves it on the host.
 */
const RAILPACK_KNOBS = new Map<string, Knob>([
  ['RAILPACK_PRUNE_DEPS', FLAG],
  ['RAILPACK_NODE_PLAYWRIGHT_INSTALL', FLAG],
  ['RAILPACK_NO_SPA', FLAG],
  [
    'RAILPACK_DISABLE_CACHES',
    {
      ok: (v) => /^(?:\*|[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*)$/.test(v),
      says: 'cache names one space apart, or *',
    },
  ],
  [
    'RAILPACK_SPA_OUTPUT_DIR',
    {
      // Joined onto /app and served: nothing may climb out of the app.
      ok: (v) =>
        /^[A-Za-z0-9._/-]{1,200}$/.test(v) && !v.startsWith('/') && !v.split('/').includes('..'),
      says: 'a directory inside the repo, such as dist',
    },
  ],
  [
    'RAILPACK_NODE_VERSION',
    {
      ok: (v) => /^\d{1,3}(?:\.\d{1,4}){0,2}$/.test(v),
      says: 'a Node version number, such as 24 or 24.18.1',
    },
  ],
  ['RAILPACK_BUILD_APT_PACKAGES', APT_PACKAGES],
  ['RAILPACK_DEPLOY_APT_PACKAGES', APT_PACKAGES],
])

export const RAILPACK_KNOB_NAMES: readonly string[] = [...RAILPACK_KNOBS.keys()]

/**
 * Why a well-formed name (it passed its map's pattern) is still refused, as the
 * rest of a sentence that starts "<NAME> is", or null.
 */
export function buildEnvNameRefusal(kind: BuildEnvKind, name: string): string | null {
  if (kind === 'placeholders') {
    return isReservedEnvName(name)
      ? "reserved: the builder's own tools read it (the shell, git, mise, BuildKit, the package managers)"
      : null
  }
  if (name.endsWith('_CMD')) {
    return "a command, and start, build and install commands belong in the repo's railpack.json"
  }
  if (!RAILPACK_KNOBS.has(name)) {
    return `not a Railpack switch this box passes on (${RAILPACK_KNOB_NAMES.join(', ')})`
  }
  return null
}

/** What a Railpack switch's value must be, when this one is not; null when it fits. */
export function railpackValueRefusal(name: string, value: string): string | null {
  const knob = RAILPACK_KNOBS.get(name)
  return knob === undefined || knob.ok(value) ? null : knob.says
}

const encoder = new TextEncoder()

/** The request file's exact bytes (lib/build-bridge.ts writes this). */
export function serializeBuildRequest(req: BuildRequest): string {
  return `${JSON.stringify(req, null, 2)}\n`
}

export const buildRequestBytes = (req: BuildRequest): number =>
  encoder.encode(serializeBuildRequest(req)).length

/** Both maps as the request carries them: the `buildEnv` field, indented as the file is. */
export const buildEnvBytes = (env: BuildEnv): number =>
  encoder.encode(JSON.stringify({ buildEnv: env }, null, 2)).length

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
  /** Absent in requests from before the field; the host treats that as empty. */
  buildEnv?: BuildEnv
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

// A value reaches the host as one NAME=value line; a NUL cannot be exported.
const LINE_BREAK_OR_NUL = /[\0\r\n]/

// Error messages name the key's path — and a name once it is a well-formed env
// identifier — but never quote a value.
function envRecord(kind: BuildEnvKind): Decoder<Record<string, string>> {
  const nameRe = kind === 'placeholders' ? BUILD_ENV_PLACEHOLDER_RE : BUILD_ENV_RAILPACK_RE
  const what = kind === 'placeholders' ? 'placeholder env' : 'RAILPACK_*'
  return (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new DecodeError(p, 'expected an object')
    }
    const entries = Object.entries(v)
    if (entries.length > BUILD_ENV_ENTRIES_MAX) {
      throw new DecodeError(p, `more than ${String(BUILD_ENV_ENTRIES_MAX)} names`)
    }
    const out: Record<string, string> = {}
    for (const [k, value] of entries) {
      // Checked before the assignment: a name like `__proto__` never reaches `out`.
      if (!nameRe.test(k)) throw new DecodeError(p, `expected ${what} names`)
      const refused = buildEnvNameRefusal(kind, k)
      if (refused !== null) throw new DecodeError(p, `${k} is ${refused}`)
      const at = `${p}.${k}`
      if (typeof value !== 'string') throw new DecodeError(at, 'expected a string')
      if (value.length > BUILD_ENV_VALUE_MAX) {
        throw new DecodeError(at, `longer than ${String(BUILD_ENV_VALUE_MAX)} characters`)
      }
      if (LINE_BREAK_OR_NUL.test(value)) {
        throw new DecodeError(at, 'contains a line break or a NUL character')
      }
      const shape = kind === 'railpack' ? railpackValueRefusal(k, value) : null
      if (shape !== null) throw new DecodeError(at, `expected ${shape}`)
      out[k] = value
    }
    return out
  }
}

const buildEnvDecoder: Decoder<BuildEnv> = obj({
  placeholders: envRecord('placeholders'),
  railpack: envRecord('railpack'),
})

const buildRequestCore = obj({
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

/** `buildEnv` stays absent when absent, so an older request round-trips byte for byte. */
export const buildRequestDecoder: Decoder<BuildRequest> = (v, p) => {
  const core = buildRequestCore(v, p)
  const env = (v as Record<string, unknown>).buildEnv
  if (env === undefined) return core
  return { ...core, buildEnv: buildEnvDecoder(env, p === '' ? 'buildEnv' : `${p}.buildEnv`) }
}

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
