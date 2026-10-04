import type { ConfigName } from '../host/env'
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
import { isAppName } from './hostname'
import { redactSecrets } from './redact'

// The root helper's `build` verb: what this container asks the host builder
// to do, and what the host says back. Client-safe on purpose — the build page
// renders statuses and log tails in the browser. The host half (starting the
// build, reading the status and the log) is host/build-verb.ts.
//
// The request id is the builds row id, not the helper's run id: the host names
// the log `<id>.log` and stamps the status with it, and the queue matches the
// status back to its row by that id.

export const BUILD_STATUS_FILE = 'build-status.json'
/**
 * A running build's status must be rewritten at least this often. The host
 * heartbeats it during long phases; past this age the run is presumed dead.
 */
export const BUILD_STATUS_MAX_AGE_MS = 90_000

/**
 * Also the log file's stem, so nothing a request carries can name a path.
 * nix/stacks/daedalus/host/build-stages/states.sh holds the host's copy, and
 * builds.test.ts holds the two to one text.
 */
export const BUILD_ID_RE = /^[0-9a-fA-F-]{1,64}$/
export const BUILD_SHA_RE = /^[0-9a-f]{40}$/

export const BUILD_STRATEGIES = ['auto', 'railpack', 'dockerfile'] as const
export const BUILD_PUBLISH_MODES = ['live', 'candidate'] as const
export const BUILD_LANES = ['main', 'pr'] as const
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
 * The app's Railpack switches, from its `railpackEnv` column. The host exports
 * them into Railpack's process env and passes the names — never the values —
 * on argv, so a name is a strict env identifier. The box passes no build
 * secrets: a repo that needs a build-time value declares a dummy one in its
 * own railpack.json, and a plan that asks for a secret fails detection.
 */
export type BuildEnv = {
  railpack: Record<string, string>
}

// Every limit below is nix/stacks/daedalus/host/build.sh's own (its buildEnv
// jq check), so a request this decoder passes is one the host accepts.
export const BUILD_ENV_RAILPACK_RE = /^RAILPACK_[A-Z0-9_]{1,55}$/
export const BUILD_ENV_VALUE_MAX = 512
export const BUILD_ENV_ENTRIES_MAX = 40

// ── the Railpack switches, identical on the host ───────────────────────────
//
// nix/stacks/daedalus/host/build.sh holds the same rule as one assignment,
// RAILPACK_KNOBS (RAILPACK_KNOB_PATTERNS as JSON). The host refuses on its own
// whatever this file refuses, because the container can write a request
// directly. builds.test.ts reads that assignment out of the host file when it
// can see one and fails on any difference; change both together.

/**
 * A value pattern runs twice: here as a JavaScript RegExp and on the host in
 * jq's Oniguruma. So each is written in what the two read alike — ASCII classes
 * (`[0-9]`, never `\d`, which Oniguruma widens to every Unicode digit),
 * lookahead but no lookbehind, no flags — and only ever meets a single-line
 * value (both sides refuse line breaks first, and Oniguruma's `$` also matches
 * before a final newline).
 */
type Knob = { pattern: string; says: string }

const FLAG: Knob = { pattern: '^(?:true|false|1|0)$', says: 'true, false, 1 or 0' }
// Railpack splits a list on single spaces (core/app/environment.go).
const APT_PACKAGE = '[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?'
const APT_PACKAGES: Knob = {
  pattern: `^${APT_PACKAGE}(?: ${APT_PACKAGE})*$`,
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
      pattern: '^(?:\\*|[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*)$',
      says: 'cache names one space apart, or *',
    },
  ],
  [
    'RAILPACK_SPA_OUTPUT_DIR',
    {
      // Joined onto /app and served: nothing may climb out of the app. Not
      // absolute, and no `..` segment anywhere.
      pattern: '^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9._/-]{1,200}$',
      says: 'a directory inside the repo, such as dist',
    },
  ],
  [
    'RAILPACK_NODE_VERSION',
    {
      pattern: '^[0-9]{1,3}(?:\\.[0-9]{1,4}){0,2}$',
      says: 'a Node version number, such as 24 or 24.18.1',
    },
  ],
  ['RAILPACK_BUILD_APT_PACKAGES', APT_PACKAGES],
  ['RAILPACK_DEPLOY_APT_PACKAGES', APT_PACKAGES],
])

const KNOB_RES = new Map([...RAILPACK_KNOBS].map(([name, k]) => [name, new RegExp(k.pattern)]))

export const RAILPACK_KNOB_NAMES: readonly string[] = [...RAILPACK_KNOBS.keys()]

/** Switch name → value pattern: host/build.sh RAILPACK_KNOBS, exactly. */
export const RAILPACK_KNOB_PATTERNS: Readonly<Record<string, string>> = Object.fromEntries(
  [...RAILPACK_KNOBS].map(([name, k]) => [name, k.pattern]),
)

/**
 * Why a well-formed name (it passed RAILPACK_*) is still refused, as the rest
 * of a sentence that starts "<NAME> is", or null.
 */
export function buildEnvNameRefusal(name: string): string | null {
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
  const re = KNOB_RES.get(name)
  return knob === undefined || re === undefined || re.test(value) ? null : knob.says
}

/** The request's exact bytes: the payload host/build-verb.ts hands the root helper. */
export function serializeBuildRequest(req: BuildRequest): string {
  return `${JSON.stringify(req, null, 2)}\n`
}

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
  buildEnv: BuildEnv
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
   * `railpack prepare` files). Kept undecoded here —
   * lib/build-detect.ts reads it, tolerating Railpack's 0.x churn.
   */
  detected: unknown
  /**
   * What the agent read out of the clone: `{ hasStartMjs, packageManager,
   * scripts, dependencies, productionDependencies, allowBuilds }`. The half of
   * the warning rules' RepoFacts only the host can see — the other half is the
   * app's own row. Kept undecoded here and read by lib/build-detect.ts
   * `readRepoFacts`.
   */
  repo: unknown
  /** `{ tags, layers, layerSizes, configSize, mediaType }` — lib/build-facts.ts. */
  image: unknown
  /** `{ runner, cacheImported, cacheExported, stepsCached, stepsTotal }`. */
  build: unknown
  checks: BuildChecks | null
  /** Host words, already passed through redactSecrets. */
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

/** The one app-name rule (lib/hostname.ts), as a decoder. */
const appNameField: Decoder<string> = (v, p) => {
  const s = str(v, p)
  if (!isAppName(s)) throw new DecodeError(p, 'expected an app name')
  return s
}

const repoId: Decoder<number> = (v, p) => {
  const n = num(v, p)
  if (!Number.isSafeInteger(n) || n <= 0) throw new DecodeError(p, 'expected a positive integer')
  return n
}

const unknownValue: Decoder<unknown> = (v) => v

const redacted: Decoder<string> = (v, p) => redactSecrets(str(v, p))

// A value reaches the host as one NAME=value line; a NUL cannot be exported.
const LINE_BREAK_OR_NUL = /[\0\r\n]/

// Error messages name the key's path — and a name once it is a well-formed env
// identifier — but never quote a value.
function railpackRecord(): Decoder<Record<string, string>> {
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
      if (!BUILD_ENV_RAILPACK_RE.test(k)) throw new DecodeError(p, 'expected RAILPACK_* names')
      const refused = buildEnvNameRefusal(k)
      if (refused !== null) throw new DecodeError(p, `${k} is ${refused}`)
      const at = `${p}.${k}`
      if (typeof value !== 'string') throw new DecodeError(at, 'expected a string')
      if (value.length > BUILD_ENV_VALUE_MAX) {
        throw new DecodeError(at, `longer than ${String(BUILD_ENV_VALUE_MAX)} characters`)
      }
      if (LINE_BREAK_OR_NUL.test(value)) {
        throw new DecodeError(at, 'contains a line break or a NUL character')
      }
      const shape = railpackValueRefusal(k, value)
      if (shape !== null) throw new DecodeError(at, `expected ${shape}`)
      out[k] = value
    }
    return out
  }
}

const buildEnvDecoder: Decoder<BuildEnv> = obj({ railpack: railpackRecord() })

export const buildRequestDecoder: Decoder<BuildRequest> = obj({
  version: versionOne,
  id: matching(BUILD_ID_RE, 'a build id'),
  app: appNameField,
  sha: matching(BUILD_SHA_RE, 'a 40-hex commit sha'),
  repoId,
  strategy: literal(...BUILD_STRATEGIES),
  publish: literal(...BUILD_PUBLISH_MODES),
  requestedBy: literal(...BUILD_REQUESTERS),
  at: str,
  buildEnv: buildEnvDecoder,
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
  // Undecoded, like `detected`, and for the same reason: a decoder that threw
  // on a renamed field would turn a cosmetic agent change into a build the
  // engine cannot read the status of at all.
  repo: optional(unknownValue, null),
  image: optional(unknownValue, null),
  build: optional(unknownValue, null),
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

export type EnvReader = (name: ConfigName) => string | undefined

const DEFAULT_BUILD_LOGS_PATH = '/builds'

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
