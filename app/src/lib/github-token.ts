import { type EnvReader, redactBuildLog } from './builds'
import {
  DecodeError,
  type Decoder,
  literal,
  nullable,
  num,
  obj,
  optional,
  str,
} from './contract/decode'
import { readSnapshot, type SnapshotResult } from './contract/snapshot'

// The GitHub App installation token, as the host's minter publishes it
// (daedalus-github-token, every 30 minutes and on request) into a read-only
// mount. The App's private key never reaches this container; this file is the
// most it ever holds — a one-hour token scoped to contents/metadata read and
// checks/deployments write. Server-only, and the token must never be logged,
// returned in an error, or sent to the browser (`publicInstallation`).

export const DEFAULT_GITHUB_TOKEN_PATH = '/github-token/installation.json'
/** The minter runs every 30 minutes; a 70-minute-old file means it stopped. */
export const GITHUB_TOKEN_MAX_AGE_MS = 70 * 60_000
/** Less than this left and a clone or a check-run PATCH could outlive the token. */
export const TOKEN_MIN_REMAINING_MS = 5 * 60_000

export type GithubInstallationState = 'ok' | 'not-installed' | 'error'

export type GithubInstallation = {
  version: 1
  state: GithubInstallationState
  reason: string | null
  installationId: number | null
  account: { login: string; id: number } | null
  repositorySelection: string | null
  token: string | null
  expiresAt: string | null
  mintedAt: string
}

export const NO_INSTALLATION: GithubInstallation = {
  version: 1,
  state: 'error',
  reason: 'the token minter has not published an installation file',
  installationId: null,
  account: null,
  repositorySelection: null,
  token: null,
  expiresAt: null,
  mintedAt: '',
}

const versionOne: Decoder<1> = (v, p) => {
  if (v !== 1) throw new DecodeError(p, 'unsupported version')
  return 1
}

/**
 * Decode errors reach the server log and the snapshot's `error`, and
 * `literal` quotes the offending value — which, in a file that carries a
 * token, could be the token. Values are cut from every message.
 */
function withoutValues<T>(d: Decoder<T>): Decoder<T> {
  return (v, p) => {
    try {
      return d(v, p)
    } catch (e) {
      if (!(e instanceof DecodeError)) throw new DecodeError(p, 'malformed installation file')
      const prefix = `${e.path === '' ? '$' : e.path}: `
      const bare = e.message.startsWith(prefix) ? e.message.slice(prefix.length) : e.message
      throw new DecodeError(
        e.path,
        redactBuildLog(bare.replace(/, got "[\s\S]*$/, ', got another string')),
      )
    }
  }
}

export const githubInstallationDecoder: Decoder<GithubInstallation> = withoutValues(
  obj({
    version: versionOne,
    state: literal('ok', 'not-installed', 'error'),
    reason: optional(
      nullable((v, p) => redactBuildLog(str(v, p))),
      null,
    ),
    installationId: optional(nullable(num), null),
    account: optional(nullable(obj({ login: str, id: num })), null),
    repositorySelection: optional(nullable(str), null),
    token: optional(nullable(str), null),
    expiresAt: optional(nullable(str), null),
    mintedAt: str,
  }),
)

const processEnv: EnvReader = (name) => {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

export async function readGithubInstallation(
  env: EnvReader = processEnv,
): Promise<SnapshotResult<GithubInstallation>> {
  return readSnapshot({
    path: env('GITHUB_TOKEN_PATH') ?? DEFAULT_GITHUB_TOKEN_PATH,
    decoder: githubInstallationDecoder,
    fallback: NO_INSTALLATION,
    acceptVersions: [1],
    maxAgeMs: GITHUB_TOKEN_MAX_AGE_MS,
  })
}

/**
 * Whether the published token can be used right now. Staleness alone does not
 * disqualify it: the minter keeps the last token to its expiry when GitHub is
 * unreachable, and `expiresAt` is the authority on whether it still works.
 */
export function tokenUsable(
  snapshot: SnapshotResult<GithubInstallation>,
  now: Date | number = Date.now(),
): boolean {
  const d = snapshot.data
  if (!snapshot.available || d.state !== 'ok' || !d.token) return false
  const expires = Date.parse(d.expiresAt ?? '')
  const at = typeof now === 'number' ? now : now.getTime()
  return Number.isFinite(expires) && expires - at > TOKEN_MIN_REMAINING_MS
}

/** The token when usable, else null. */
export function usableToken(
  snapshot: SnapshotResult<GithubInstallation>,
  now: Date | number = Date.now(),
): string | null {
  return tokenUsable(snapshot, now) ? snapshot.data.token : null
}

/** The installation without its token — the only shape that may leave the server. */
export function publicInstallation(
  installation: GithubInstallation,
): Omit<GithubInstallation, 'token'> & { hasToken: boolean } {
  const { token, ...rest } = installation
  return { ...rest, hasToken: typeof token === 'string' && token !== '' }
}
