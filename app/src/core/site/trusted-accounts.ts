import type { Ctx } from '../ctx'
import { otherInstallations } from '../github-app'
import type { SiteGithubApp, SiteTrustedAccount } from './file'
import { saveSiteEdit, siteEdit } from './index'

// Which accounts besides the owner the box trusts with its GitHub App.
//
// A public App can be installed by anyone. The host's token minter sees every
// installation, mints read-only tokens only for the accounts listed here
// (site.json `github.trustedAccounts`, rendered by nix as the minter's
// TRUSTED_ACCOUNT_IDS), and publishes the rest as `untrusted` without one —
// which is how an installation shows up on Settings › Integrations asking to
// be trusted. Trusting is picking one of THOSE: an account is only ever added
// from an installation GitHub reported, by its numeric id, so a typo or a
// renamed login can never grant anything. Every change is a site edit and
// lands on the next Apply.

/** GitHub's login charset; the value reaches the minter's shell through nix. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/** Why a list may not be saved, or null. The generic site save runs this too. */
export function trustedAccountsError(value: unknown, app: SiteGithubApp | null): string | null {
  if (!Array.isArray(value)) return 'the trusted accounts are a list'
  const ids = new Set<number>()
  for (const v of value as unknown[]) {
    const a = v as Partial<SiteTrustedAccount> | null
    if (a === null || typeof a !== 'object') return 'each trusted account is { login, id }'
    if (typeof a.login !== 'string' || !LOGIN.test(a.login)) return 'not a GitHub login'
    if (typeof a.id !== 'number' || !Number.isSafeInteger(a.id) || a.id <= 0) {
      return 'a GitHub account id is a positive whole number'
    }
    if (app !== null && a.id === app.ownerId)
      return `${a.login} owns the App; it is trusted already`
    if (ids.has(a.id)) return `${a.login} is listed twice`
    ids.add(a.id)
  }
  return null
}

type Outcome = { ok: true } | { ok: false; reason: string }

async function trusted(ctx: Ctx): Promise<SiteTrustedAccount[]> {
  return (await siteEdit(ctx)).desired.github?.trustedAccounts ?? []
}

/** Trust the account behind an installation the minter reported. */
export async function trustInstallation(ctx: Ctx, installationId: number): Promise<Outcome> {
  const inst = (await otherInstallations(ctx)).data.find((i) => i.installationId === installationId)
  if (inst?.account === null || inst?.account === undefined) {
    return {
      ok: false,
      reason: 'GitHub has not reported that installation; it may have been removed',
    }
  }
  const list = await trusted(ctx)
  if (list.some((a) => a.id === inst.account?.id)) {
    return { ok: false, reason: `${inst.account.login} is trusted already` }
  }
  await saveSiteEdit(ctx, {
    'github.trustedAccounts': [...list, { login: inst.account.login, id: inst.account.id }],
  })
  return { ok: true }
}

/** Stop trusting an account: the next Apply, then the next mint, drops its token. */
export async function untrustAccount(ctx: Ctx, id: number): Promise<Outcome> {
  const list = await trusted(ctx)
  if (!list.some((a) => a.id === id)) return { ok: false, reason: 'not trusted' }
  await saveSiteEdit(ctx, { 'github.trustedAccounts': list.filter((a) => a.id !== id) })
  return { ok: true }
}

/** GitHub's public answer for an account: who it is, by the id that never changes. */
type GithubUser = { login?: unknown; id?: unknown; type?: unknown }

/**
 * Trust an account by name, before it installs the App: looked up on
 * GitHub's public API (no credential, so it is the same for every box) and
 * kept by the numeric id that answer carries. The page then offers the
 * install link with that account picked.
 */
export async function trustAccount(ctx: Ctx, raw: string): Promise<Outcome> {
  const login = raw.trim().replace(/^@/, '')
  if (!LOGIN.test(login)) return { ok: false, reason: 'not a GitHub account name' }
  const { ghAnon } = await import('../github-app')
  const r = await ghAnon<GithubUser>(`/users/${login}`)
  if (r.status === 404) return { ok: false, reason: `GitHub has no account named ${login}` }
  if (r.status !== 200 || r.body === null) return { ok: false, reason: 'GitHub did not answer' }
  const id = r.body.id
  const name = r.body.login
  if (typeof id !== 'number' || typeof name !== 'string') {
    return { ok: false, reason: 'GitHub answered with something that is not an account' }
  }
  const list = await trusted(ctx)
  if (list.some((a) => a.id === id)) return { ok: false, reason: `${name} is trusted already` }
  const app = (await siteEdit(ctx)).desired.github?.app ?? null
  const problem = trustedAccountsError([...list, { login: name, id }], app)
  if (problem !== null) return { ok: false, reason: problem }
  await saveSiteEdit(ctx, { 'github.trustedAccounts': [...list, { login: name, id }] })
  return { ok: true }
}
