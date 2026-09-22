import { createServerFn } from '@tanstack/react-start'
import { actorLabel, actorOrNull, requireActor } from '../core/auth'
import type { TokenReplaceOutcome } from '../core/settings/cloudflare-token'
import type {
  BoxSettings,
  GithubAppApply,
  GithubAppDiscard,
  GithubAppStart,
  GithubAppStatus,
  IntegrationStatus,
  ZoneList,
} from '../core/settings/types'
import type { McpTokenRow } from '../host/mcp/tokens'
import { type ExternalApp, type ExternalAppInput, isPlatform } from '../lib/external-apps'
import { isRecord } from '../lib/is-record'
import { isMcpScope, type McpScope } from '../lib/mcp'
import type { Result } from '../lib/result'
import { DEFAULT_THEME, isThemeChoice, presetById, type ThemeChoice } from '../lib/theme'

// Server functions behind Settings: the read-only facts (core/settings), the
// live integration checks, and the one preference that is editable. Values
// in the preference store never reach the site repo and never trigger a
// rebuild — see the `settings` table comment in host/schema.ts for where that
// line is drawn.
//
// Value imports are dynamic so the database module is not pulled into a client
// bundle by a type import, matching server/registry.ts.

export const fetchBoxSettings = createServerFn().handler(async (): Promise<BoxSettings> => {
  const { makeCtx } = await import('../core/ctx')
  const { readBoxSettings } = await import('../core/settings')
  return readBoxSettings(await makeCtx())
})

export const fetchIntegrationStatus = createServerFn().handler(
  async (): Promise<IntegrationStatus> => {
    const { makeCtx } = await import('../core/ctx')
    const { integrationStatus } = await import('../core/settings/integrations')
    return integrationStatus(await makeCtx())
  },
)

/**
 * General's deferred half: the zones the Cloudflare API token can see, for
 * the domain picker. It asks Cloudflare, so the tab renders its facts first
 * and this streams in behind them.
 */
export const fetchZones = createServerFn().handler(async (): Promise<ZoneList> => {
  const { makeCtx } = await import('../core/ctx')
  const { listZones } = await import('../core/settings/zones')
  return listZones(await makeCtx())
})

/**
 * Settings › Integrations › Cloudflare › Replace token. The token is checked
 * against Cloudflare, encrypted in this container and handed to Apply as
 * ciphertext (core/settings/cloudflare-token.ts); it is never stored, logged
 * or sent back.
 */
export const replaceCloudflareTokenFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { token: string } => {
    const token = (data as { token?: unknown } | null)?.token
    if (typeof token !== 'string') throw new Error('expected a token')
    return { token }
  })
  .handler(async ({ data }): Promise<TokenReplaceOutcome> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { replaceCloudflareToken } = await import('../core/settings/cloudflare-token')
    const actor = actorLabel()
    return replaceCloudflareToken(await makeCtx(), actor, data.token)
  })

/**
 * Settings › Integrations › GitHub App (core/settings/github-app.ts). The
 * page gets the manifest and state to POST to github.com, and ids back; the
 * App's key and secrets only ever reach the server, and leave it as ciphertext.
 */
export const fetchGithubAppStatus = createServerFn().handler(async (): Promise<GithubAppStatus> => {
  const { makeCtx } = await import('../core/ctx')
  const { githubAppStatus } = await import('../core/settings/github-app')
  return githubAppStatus(await makeCtx())
})

export const startGithubAppFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { name: string; replace: boolean } => {
    const d = data as { name?: unknown; replace?: unknown } | null
    if (typeof d?.name !== 'string' || d.name.length > 200) throw new Error('expected an App name')
    if (d.replace !== undefined && typeof d.replace !== 'boolean') {
      throw new Error('expected replace to be true or false')
    }
    return { name: d.name, replace: d.replace === true }
  })
  .handler(async ({ data }): Promise<GithubAppStart> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { startAppCreation } = await import('../core/settings/github-app')
    // No fallback name: a missing identity is null, and every App mutation refuses it.
    const actor = actorOrNull(requireActor())
    return startAppCreation(await makeCtx(), actor, data)
  })

export const pasteAppKeyFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { pem: string; webhookSecret: string; clientSecret: string } => {
    const d = data as { pem?: unknown; webhookSecret?: unknown; clientSecret?: unknown } | null
    // The messages name the field, never its value.
    if (typeof d?.pem !== 'string' || d.pem.length > 16_384)
      throw new Error('expected a private key')
    if (typeof d.webhookSecret !== 'string' || d.webhookSecret.length > 1024) {
      throw new Error('expected a webhook secret')
    }
    if (typeof d.clientSecret !== 'string' || d.clientSecret.length > 1024) {
      throw new Error('expected a client secret')
    }
    return { pem: d.pem, webhookSecret: d.webhookSecret, clientSecret: d.clientSecret }
  })
  .handler(async ({ data }): Promise<GithubAppApply> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { pasteAppKey } = await import('../core/settings/github-app')
    const actor = actorOrNull(requireActor())
    return pasteAppKey(await makeCtx(), actor, data)
  })

export const retryGithubApplyFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<GithubAppApply> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { retryPendingApply } = await import('../core/settings/github-app')
    const actor = actorOrNull(requireActor())
    return retryPendingApply(await makeCtx(), actor)
  },
)

/**
 * Forget a created App's pending Apply. The enabled flag and the actor are
 * checked in core/settings/github-app.ts, like every other App mutation.
 */
export const discardGithubPendingApplyFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<GithubAppDiscard> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { discardPendingApply } = await import('../core/settings/github-app')
    const actor = actorOrNull(requireActor())
    return discardPendingApply(await makeCtx(), actor)
  },
)

/**
 * Where GitHub's setup redirect lands after the App is installed or its
 * repositories change. The query's installation_id is never read — anyone can
 * type one into a link — so all this does is ask the host's minter to look
 * now; the minter finds the installation on its own.
 */
export const githubInstallLandedFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<Result<null>> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const gate = requireActor()
    if (!gate.ok) return gate
    const { requestTokenRefresh } = await import('../core/github-app')
    await requestTokenRefresh()
    return { ok: true, value: null }
  },
)

/** The zone names this system's tzdata carries: the timezone picker's list. */
export const fetchTimezones = createServerFn().handler(async (): Promise<string[]> => {
  const { readTimezones } = await import('../core/settings/timezones')
  return readTimezones()
})

export const fetchTheme = createServerFn().handler(async (): Promise<ThemeChoice> => {
  const { readSetting, SETTING_KEYS } = await import('../lib/repo/settings')
  // A control plane that will not render because its theme row is
  // unreadable is worse than one rendering in the default palette.
  try {
    return (await readSetting(SETTING_KEYS.theme, isThemeChoice)) ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
})

export const saveTheme = createServerFn({ method: 'POST' })
  .validator((data: unknown): ThemeChoice => {
    if (!isThemeChoice(data)) throw new Error('not a theme choice')
    // Reject an unknown preset id here rather than storing it and falling
    // back on every read: a preference the UI cannot show as selected is
    // indistinguishable from one that did not save.
    if (presetById(data.presetId).id !== data.presetId) throw new Error('unknown preset')
    return { presetId: data.presetId, scheme: data.scheme }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { writeSetting, SETTING_KEYS } = await import('../lib/repo/settings')
    await writeSetting(SETTING_KEYS.theme, data)
    return data
  })

// ── Settings › Projects ─────────────────────────────────────────────────────
//
// The second editable preference, and the same kind as the theme: a row in
// Postgres, saved on click, nothing rebuilds. core/settings/external-apps.ts
// holds the rules; these are its doors, behind the admin gate like every
// other mutation.

export const fetchExternalApps = createServerFn().handler(async (): Promise<ExternalApp[]> => {
  const { makeCtx } = await import('../core/ctx')
  const { listExternalApps } = await import('../core/settings/external-apps')
  return listExternalApps(await makeCtx())
})

/** Add a row. The refusal is the sentence the form shows under the fields. */
export const addExternalAppFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): ExternalAppInput => {
    if (
      !isRecord(data) ||
      typeof data.name !== 'string' ||
      typeof data.host !== 'string' ||
      typeof data.description !== 'string' ||
      !(data.repo === null || typeof data.repo === 'string')
    ) {
      throw new Error('expected a name, host, platform, description and repo')
    }
    if (!isPlatform(data.platform)) throw new Error('not a platform this build knows')
    return {
      name: data.name,
      host: data.host,
      platform: data.platform,
      description: data.description,
      repo: data.repo,
    }
  })
  .handler(async ({ data }): Promise<Result<ExternalApp>> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { addExternalApp } = await import('../core/settings/external-apps')
    return addExternalApp(await makeCtx(), data)
  })

/** Drop a row. The site keeps running wherever it runs; only the listing goes. */
export const removeExternalAppFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string } => {
    if (!isRecord(data) || typeof data.id !== 'string') throw new Error('expected a row id')
    return { id: data.id }
  })
  .handler(async ({ data }): Promise<Result<null>> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { removeExternalApp } = await import('../core/settings/external-apps')
    const done = await removeExternalApp(await makeCtx(), data.id)
    return done ? { ok: true, value: null } : { ok: false, reason: 'No such row.' }
  })

// ── Settings › Developer › MCP tokens ──────────────────────────────────────
//
// The credentials that reach /mcp. Minting is a mutation like any other and
// goes through the same admin gate; the VALUE is returned exactly once, from
// this call, and is never recoverable afterwards — host/mcp/tokens.ts stores a
// digest. The panel shows it once and then forgets it too.

export const fetchMcpTokens = createServerFn().handler(async (): Promise<McpTokenRow[]> => {
  const { listMcpTokens } = await import('../host/mcp/tokens')
  return listMcpTokens()
})

/** Mint a token. The one call in this app whose response is a secret. */
export const mintMcpTokenFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { label: string; scope: McpScope } => {
    if (!isRecord(data)) throw new Error('expected a label and a scope')
    if (typeof data.label !== 'string') throw new Error('expected a label')
    if (!isMcpScope(data.scope)) throw new Error('scope must be read or write')
    return { label: data.label, scope: data.scope }
  })
  .handler(async ({ data }): Promise<Result<{ row: McpTokenRow; token: string }>> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { mintMcpToken } = await import('../host/mcp/tokens')
    try {
      return { ok: true, value: await mintMcpToken(data) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'could not mint the token' }
    }
  })

/** Revoke a token. The row stays, so its label still explains what it wrote. */
export const revokeMcpTokenFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string } => {
    if (!isRecord(data) || typeof data.id !== 'string') throw new Error('expected a token id')
    return { id: data.id }
  })
  .handler(async ({ data }): Promise<Result<null>> => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { revokeMcpToken } = await import('../host/mcp/tokens')
    const done = await revokeMcpToken(data.id)
    return done ? { ok: true, value: null } : { ok: false, reason: 'No such token.' }
  })

// ── Settings › Developer › Authorization ───────────────────────────────────
//
// The arming panel for core/authz.ts's `admins` check. The read is the
// decision for THIS request, so the page shows what the proxy actually sent
// rather than what the nix file says it should; the write is the switch, and
// the refusal to arm from a request that does not carry `admins` is made in
// core/authz.ts, not in a disabled button.

/** The decision for the request that rendered the page, flattened for the client. */
export type AuthorizationView = {
  /** The forwarded email, or null when the request carried no identity. */
  actor: string | null
  header: 'absent' | 'blank' | 'unparseable' | 'list' | 'local'
  groups: string[]
  admin: boolean
  enforced: boolean
}

export const fetchAuthorization = createServerFn().handler(async (): Promise<AuthorizationView> => {
  const { authorize } = await import('../core/authz')
  const d = await authorize()
  return {
    actor: d.actor.ok ? d.actor.value : null,
    header: d.header,
    groups: d.groups,
    admin: d.admin,
    enforced: d.enforced,
  }
})

/**
 * Arm or disarm refusal. Behind the same gate as every mutation, and then
 * behind one more: arming is refused unless this very request carries
 * `admins` (core/authz.ts setEnforcingAdmins). Disarming always works.
 */
export const setEnforceAdminsFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { on: boolean } => {
    if (!isRecord(data) || typeof data.on !== 'boolean') throw new Error('expected on: boolean')
    return { on: data.on }
  })
  .handler(async ({ data }): Promise<Result<null>> => {
    const { assertAdmin, authorize, setEnforcingAdmins } = await import('../core/authz')
    await assertAdmin()
    return setEnforcingAdmins(data.on, await authorize())
  })
