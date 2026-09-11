import { stripAnsi } from './ansi'
import { bool, type Decoder, nullable, num, obj, optional, str } from './contract/decode'

// The daedalus GitHub App, the pure half: the manifest the operator registers,
// what a push delivery means, and the shape a check run's output must fit.
// Client-safe — no server-only imports; the signature check is in
// github-app-crypto.ts because it needs node:crypto.

/** Site-relative path of the sealed App credentials (pem, webhookSecret, clientSecret). */
export const GITHUB_APP_FILE = 'vault/github-app.sops'

/**
 * Least privilege. `pull_requests: write` is unused until PR previews, granted
 * now because widening an App's permissions makes every installation re-accept.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
  checks: 'write',
  deployments: 'write',
  pull_requests: 'write',
} as const

/** `installation*` events are delivered to every App without subscribing. */
export const GITHUB_APP_EVENTS = ['push', 'repository'] as const

export const CHECK_RUN_NAME = 'daedalus'

/** The one label under the base domain the public webhook router answers on. */
export const HOOKS_HOST_LABEL = 'hooks'
export const GITHUB_WEBHOOK_PATH = '/api/github/webhook'

// ── manifest ───────────────────────────────────────────────────────────────

export type GithubAppManifest = {
  name: string
  url: string
  hook_attributes: { url: string; active: boolean }
  redirect_url: string
  setup_url: string
  setup_on_update: boolean
  public: boolean
  default_permissions: Record<string, 'read' | 'write'>
  default_events: string[]
}

export function buildManifest(input: {
  name: string
  baseDomain: string
  controlPlaneHost: string
}): GithubAppManifest {
  const origin = `https://${input.controlPlaneHost}`
  return {
    name: input.name,
    url: origin,
    hook_attributes: {
      url: `https://${HOOKS_HOST_LABEL}.${input.baseDomain}${GITHUB_WEBHOOK_PATH}`,
      active: true,
    },
    redirect_url: `${origin}/settings/github/callback`,
    setup_url: `${origin}/settings?tab=integrations`,
    setup_on_update: true,
    public: false,
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    default_events: [...GITHUB_APP_EVENTS],
  }
}

export function installUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
}

// ── push deliveries ────────────────────────────────────────────────────────

export type GithubPushEvent = {
  ref: string
  before: string
  after: string
  deleted: boolean
  forced: boolean
  repository: {
    id: number
    name: string
    full_name: string
    default_branch: string
    fork: boolean
    owner: { id: number; login: string }
  }
  installation: { id: number } | null
  head_commit: { id: string; message: string; author: { name: string } } | null
  sender: { login: string } | null
}

/** Only the fields classification and reporting read; `commits[]` is never trusted. */
export const pushEventDecoder: Decoder<GithubPushEvent> = obj({
  ref: str,
  before: str,
  after: str,
  deleted: bool,
  forced: bool,
  repository: obj({
    id: num,
    name: str,
    full_name: str,
    default_branch: str,
    fork: bool,
    owner: obj({ id: num, login: str }),
  }),
  installation: optional(nullable(obj({ id: num })), null),
  // null on a branch delete.
  head_commit: optional(nullable(obj({ id: str, message: str, author: obj({ name: str }) })), null),
  sender: optional(nullable(obj({ login: str })), null),
})

export type PushIgnoreReason =
  | 'deleted'
  | 'tag'
  | 'non-default-branch'
  | 'zero-sha'
  | 'invalid-sha'
  | 'owner-mismatch'
  | 'fork'
  | 'installation-mismatch'
  | 'no-app'
  | 'repo-not-pinned'
  | 'repo-mismatch'

export type PushClassification =
  | { kind: 'build'; sha: string; repoId: number; repoName: string }
  | { kind: 'ignore'; reason: PushIgnoreReason }

export type PushContext = {
  /** The App owner's numeric account id (site.json `github.app.ownerId`). */
  ownerId: number
  /** The installation the token minter found; null when not known yet. */
  installationId: number | null
  /**
   * The app named by the lowercased repo name; null when none exists. Its
   * githubRepoId is null until the repo picker or the installation listing
   * pins it — never a push.
   */
  app: { githubRepoId: number | null } | null
}

const SHA = /^[0-9a-f]{40}$/
const ZERO_SHA = '0'.repeat(40)

/**
 * Whether a push should build. This is the engine's filter, not the security
 * boundary: the host resolves the default branch itself and builds only when
 * the sha IS the tip, which is what stops replays and out-of-order deliveries.
 */
export function classifyPush(event: GithubPushEvent, ctx: PushContext): PushClassification {
  const ignore = (reason: PushIgnoreReason): PushClassification => ({ kind: 'ignore', reason })
  const repo = event.repository

  if (event.deleted) return ignore('deleted')
  if (event.ref.startsWith('refs/tags/')) return ignore('tag')
  if (event.ref !== `refs/heads/${repo.default_branch}`) return ignore('non-default-branch')
  if (event.after === ZERO_SHA) return ignore('zero-sha')
  if (!SHA.test(event.after)) return ignore('invalid-sha')
  if (repo.owner.id !== ctx.ownerId) return ignore('owner-mismatch')
  if (repo.fork) return ignore('fork')
  if (
    event.installation !== null &&
    ctx.installationId !== null &&
    event.installation.id !== ctx.installationId
  ) {
    return ignore('installation-mismatch')
  }
  if (ctx.app === null) return ignore('no-app')
  // The id is pinned from the picker or the installation listing, never from a
  // push: trusting the first push to pin it would let whichever repo holds the
  // name at that moment claim the app.
  if (ctx.app.githubRepoId === null) return ignore('repo-not-pinned')
  // A repo deleted and recreated under the same name keeps the name, not the id.
  if (ctx.app.githubRepoId !== repo.id) return ignore('repo-mismatch')
  return { kind: 'build', sha: event.after, repoId: repo.id, repoName: repo.name.toLowerCase() }
}

// ── check run output ───────────────────────────────────────────────────────

// GitHub caps summary and text at 65,535 bytes each; the margin leaves the
// caller room for a code fence around the log.
export const SUMMARY_MAX_BYTES = 60_000
export const TEXT_MAX_BYTES = 64_000
export const TEXT_OMITTED_PREFIX = '… earlier lines omitted\n'
export const SUMMARY_TRUNCATED_SUFFIX = '\n… truncated'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const isContinuation = (b: number | undefined): boolean => b !== undefined && (b & 0xc0) === 0x80

function byteLength(s: string): number {
  return encoder.encode(s).length
}

/** The first ≤ max bytes, never ending inside a multibyte character. */
function headBytes(bytes: Uint8Array, max: number): string {
  let end = Math.max(0, max)
  while (end > 0 && isContinuation(bytes[end])) end--
  return decoder.decode(bytes.subarray(0, end))
}

/**
 * The last ≤ max bytes, starting on a whole line when the tail holds a line
 * break (a newline byte is never inside a multibyte character, so that start
 * is also a character boundary), else on the first whole character.
 */
function tailLines(bytes: Uint8Array, max: number): string {
  let start = bytes.length - Math.max(0, max)
  if (bytes[start - 1] !== 0x0a) {
    const nl = bytes.indexOf(0x0a, start)
    if (nl !== -1 && nl + 1 < bytes.length) start = nl + 1
    else while (start < bytes.length && isContinuation(bytes[start])) start++
  }
  return decoder.decode(bytes.subarray(start))
}

function truncateSummary(s: string): string {
  const bytes = encoder.encode(s)
  if (bytes.length <= SUMMARY_MAX_BYTES) return s
  const budget = SUMMARY_MAX_BYTES - byteLength(SUMMARY_TRUNCATED_SUFFIX)
  return headBytes(bytes, budget) + SUMMARY_TRUNCATED_SUFFIX
}

function truncateText(s: string): string {
  const bytes = encoder.encode(s)
  if (bytes.length <= TEXT_MAX_BYTES) return s
  const budget = TEXT_MAX_BYTES - byteLength(TEXT_OMITTED_PREFIX)
  return TEXT_OMITTED_PREFIX + tailLines(bytes, budget)
}

export type CheckRunOutput = { title: string; summary: string; text: string }

/**
 * A check run's `output`, fitted to GitHub's limits by UTF-8 bytes (not string
 * length: the log is full of 3-byte glyphs). The log keeps its tail — the end
 * is where a build says why it failed.
 */
export function checkRunOutput(input: {
  title: string
  summary: string
  logTail: string
}): CheckRunOutput {
  return {
    title: stripAnsi(input.title),
    summary: truncateSummary(stripAnsi(input.summary)),
    text: truncateText(stripAnsi(input.logTail)),
  }
}
