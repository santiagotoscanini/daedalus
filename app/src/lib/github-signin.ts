// Signing the box in to GitHub with the OAuth device flow (PLAN.md Phase 7).
// The client-safe half: the constants, the shapes the two server functions
// answer with, and the pure readings of GitHub's replies. The server half is
// core/settings/github-signin.ts.

import type { VaultFile } from './vault'

/** The vault entry, as apply.sh allowlists it. */
export const GITHUB_TOKEN_FILE = 'vault/github-token.sops' as const satisfies VaultFile
export const GITHUB_TOKEN_SECRET = 'github-token' as const

/**
 * The daedalus OAuth App. A client id is public by design — the device flow
 * has no client secret — and it names the project's app rather than this box,
 * the way `gh` ships its own. `GITHUB_OAUTH_CLIENT_ID` in the container's
 * environment overrides it, for anyone who registers their own.
 */
export const GITHUB_OAUTH_CLIENT_ID = ''

/** The client id in force: the environment's, else the project's. '' = sign-in unavailable. */
export function oauthClientId(fromEnv: string | undefined): string {
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : GITHUB_OAUTH_CLIENT_ID
}

/**
 * What the token is asked for, which is everything the box does with one:
 * `repo` reads private repositories and their workflows, reads and sets
 * Actions secrets, dispatches workflows and mints runner registration tokens.
 */
export const GITHUB_SCOPES = ['repo'] as const

export type GithubTokenKind = 'oauth' | 'classic' | 'fine-grained' | 'unknown'

/**
 * A token's kind from its prefix. `unknown` is a real answer: a classic token
 * minted before GitHub prefixed them is forty hex characters and says nothing
 * about itself (the caller settles it from the reply's scopes header).
 */
export function githubTokenKind(token: string): GithubTokenKind {
  if (token.startsWith('gho_')) return 'oauth'
  if (token.startsWith('ghp_')) return 'classic'
  if (token.startsWith('github_pat_')) return 'fine-grained'
  return 'unknown'
}

/** The asked-for scopes an `X-OAuth-Scopes` header does not grant. */
export function missingScopes(header: string | null): string[] {
  const granted = new Set(
    (header ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
  return GITHUB_SCOPES.filter((s) => !granted.has(s))
}

export type SignInStart =
  | {
      ok: true
      /** Names the flow on the server, which keeps the device code; never the code itself. */
      flow: string
      userCode: string
      verificationUri: string
      expiresAt: string
      /** Seconds to wait between polls. */
      interval: number
    }
  | { ok: false; reason: string }

export type SignInPoll =
  | { state: 'pending'; interval: number }
  | {
      state: 'done'
      /** The Apply that writes the token to the vault. */
      id: string
      login: string
      /** The box already reads its GitHub token from the vault, so the rebuild switches to it. */
      inUse: boolean
    }
  | { state: 'failed'; reason: string }

/** GitHub's reply to one poll of the access-token endpoint. */
export type DeviceTokenReply = {
  access_token?: string
  error?: string
  /** Sent with `slow_down`: the interval GitHub now expects. */
  interval?: number
}

export type DeviceStep =
  | { kind: 'token'; token: string }
  | { kind: 'wait'; interval: number }
  | { kind: 'stop'; reason: string }

/** What one poll's reply means (RFC 8628 §3.5, with GitHub's own error names). */
export function readDeviceReply(reply: DeviceTokenReply, interval: number): DeviceStep {
  if (typeof reply.access_token === 'string' && reply.access_token !== '') {
    return { kind: 'token', token: reply.access_token }
  }
  switch (reply.error) {
    case 'authorization_pending':
      return { kind: 'wait', interval }
    case 'slow_down':
      // RFC 8628: every slow_down adds five seconds, for good. GitHub also
      // states its figure; take whichever is longer.
      return { kind: 'wait', interval: Math.max(interval + 5, reply.interval ?? 0) }
    case 'expired_token':
      return { kind: 'stop', reason: 'The code expired before it was approved. Start again.' }
    case 'access_denied':
      return { kind: 'stop', reason: 'The sign-in was cancelled on GitHub. Nothing changed.' }
    case 'device_flow_disabled':
      return {
        kind: 'stop',
        reason: 'Device flow is off for this OAuth App: tick “Enable Device Flow” in its settings.',
      }
    case 'incorrect_client_credentials':
      return { kind: 'stop', reason: 'GitHub does not recognise this OAuth App’s client id.' }
    default:
      return {
        kind: 'stop',
        reason: `GitHub refused the sign-in (${reply.error ?? 'no reason given'}). Nothing changed.`,
      }
  }
}
