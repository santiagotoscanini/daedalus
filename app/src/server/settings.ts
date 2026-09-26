import { actorOrNull, requireActor } from '../core/auth'
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
import {
  asValidator,
  bool,
  is,
  nullable,
  obj,
  optional,
  str,
  withMessage,
} from '../lib/contract/decode'
import { strMax } from '../lib/contract/fields'
import { type ExternalApp, isPlatform } from '../lib/external-apps'
import { isMcpScope } from '../lib/mcp'
import type { Result } from '../lib/result'
import { DEFAULT_THEME, isThemeChoice, presetById, type ThemeChoice } from '../lib/theme'
import { adminFn, readFn } from './fn'

// Server functions behind Settings: the read-only facts (core/settings), the
// live integration checks, and the one preference that is editable. Values
// in the preference store never reach the site repo and never trigger a
// rebuild — see the `settings` table comment in host/schema.ts for where that
// line is drawn.
//
// Value imports are dynamic so the database module is not pulled into a client
// bundle by a type import, matching server/registry.ts.

export const fetchBoxSettings = readFn.handler(async ({ context }): Promise<BoxSettings> => {
  const { readBoxSettings } = await import('../core/settings')
  return readBoxSettings(await context.ctx())
})

export const fetchIntegrationStatus = readFn.handler(
  async ({ context }): Promise<IntegrationStatus> => {
    const { integrationStatus } = await import('../core/settings/integrations')
    return integrationStatus(await context.ctx())
  },
)

/**
 * General's deferred half: the zones the Cloudflare API token can see, for
 * the domain picker. It asks Cloudflare, so the tab renders its facts first
 * and this streams in behind them.
 */
export const fetchZones = readFn.handler(async ({ context }): Promise<ZoneList> => {
  const { listZones } = await import('../core/settings/zones')
  return listZones(await context.ctx())
})

/**
 * Settings › Integrations › Cloudflare › Replace token. The token is checked
 * against Cloudflare, encrypted in this container and handed to Apply as
 * ciphertext (core/settings/cloudflare-token.ts); it is never stored, logged
 * or sent back.
 */
export const replaceCloudflareTokenFn = adminFn
  .validator(asValidator(withMessage(obj({ token: str }), 'expected a token')))
  .handler(async ({ data, context }): Promise<TokenReplaceOutcome> => {
    const { replaceCloudflareToken } = await import('../core/settings/cloudflare-token')
    return replaceCloudflareToken(await context.ctx(), context.actor(), data.token)
  })

/**
 * Settings › Integrations › GitHub App (core/settings/github-app.ts). The
 * page gets the manifest and state to POST to github.com, and ids back; the
 * App's key and secrets only ever reach the server, and leave it as ciphertext.
 */
export const fetchGithubAppStatus = readFn.handler(
  async ({ context }): Promise<GithubAppStatus> => {
    const { githubAppStatus } = await import('../core/settings/github-app')
    return githubAppStatus(await context.ctx())
  },
)

const githubAppStart = withMessage(
  obj({
    name: withMessage(strMax(200), 'expected an App name'),
    replace: withMessage(optional(bool, false), 'expected replace to be true or false'),
  }),
  'expected an App name',
)

export const startGithubAppFn = adminFn
  .validator(asValidator(githubAppStart))
  .handler(async ({ data, context }): Promise<GithubAppStart> => {
    const { startAppCreation } = await import('../core/settings/github-app')
    // No fallback name: a missing identity is null, and every App mutation refuses it.
    const actor = actorOrNull(requireActor())
    return startAppCreation(await context.ctx(), actor, data)
  })

// The messages name the field, never its value.
const githubAppKey = withMessage(
  obj({
    pem: withMessage(strMax(16_384), 'expected a private key'),
    webhookSecret: withMessage(strMax(1024), 'expected a webhook secret'),
    clientSecret: withMessage(strMax(1024), 'expected a client secret'),
  }),
  'expected a private key',
)

export const pasteAppKeyFn = adminFn
  .validator(asValidator(githubAppKey))
  .handler(async ({ data, context }): Promise<GithubAppApply> => {
    const { pasteAppKey } = await import('../core/settings/github-app')
    const actor = actorOrNull(requireActor())
    return pasteAppKey(await context.ctx(), actor, data)
  })

export const retryGithubApplyFn = adminFn.handler(async ({ context }): Promise<GithubAppApply> => {
  const { retryPendingApply } = await import('../core/settings/github-app')
  const actor = actorOrNull(requireActor())
  return retryPendingApply(await context.ctx(), actor)
})

/**
 * Forget a created App's pending Apply. The enabled flag and the actor are
 * checked in core/settings/github-app.ts, like every other App mutation.
 */
export const discardGithubPendingApplyFn = adminFn.handler(
  async ({ context }): Promise<GithubAppDiscard> => {
    const { discardPendingApply } = await import('../core/settings/github-app')
    const actor = actorOrNull(requireActor())
    return discardPendingApply(await context.ctx(), actor)
  },
)

/**
 * Where GitHub's setup redirect lands after the App is installed or its
 * repositories change. The query's installation_id is never read — anyone can
 * type one into a link — so all this does is ask the host's minter to look
 * now; the minter finds the installation on its own.
 */
export const githubInstallLandedFn = adminFn.handler(async (): Promise<Result<null>> => {
  const gate = requireActor()
  if (!gate.ok) return gate
  const { requestTokenRefresh } = await import('../core/github-app')
  await requestTokenRefresh()
  return { ok: true, value: null }
})

/** The zone names this system's tzdata carries: the timezone picker's list. */
export const fetchTimezones = readFn.handler(async (): Promise<string[]> => {
  const { readTimezones } = await import('../core/settings/timezones')
  return readTimezones()
})

export const fetchTheme = readFn.handler(async (): Promise<ThemeChoice> => {
  const { readSetting, SETTING_KEYS } = await import('../lib/repo/settings')
  // A control plane that will not render because its theme row is
  // unreadable is worse than one rendering in the default palette.
  try {
    return (await readSetting(SETTING_KEYS.theme, isThemeChoice)) ?? DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
})

// Kept as a plain check rather than a decoder: it is two refusals in order,
// the second (an unknown preset) a lookup no field decoder expresses.
export const saveTheme = adminFn
  .validator((data: unknown): ThemeChoice => {
    if (!isThemeChoice(data)) throw new Error('not a theme choice')
    // Reject an unknown preset id here rather than storing it and falling
    // back on every read: a preference the UI cannot show as selected is
    // indistinguishable from one that did not save.
    if (presetById(data.presetId).id !== data.presetId) throw new Error('unknown preset')
    return { presetId: data.presetId, scheme: data.scheme }
  })
  .handler(async ({ data }) => {
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

export const fetchExternalApps = readFn.handler(async ({ context }): Promise<ExternalApp[]> => {
  const { listExternalApps } = await import('../core/settings/external-apps')
  return listExternalApps(await context.ctx())
})

/**
 * A new row's fields. The shape is checked first and refused as one sentence;
 * the platform is decoded last, so only a well-shaped form hears its own.
 */
const externalAppInput = withMessage(
  obj({
    name: str,
    host: str,
    description: str,
    repo: nullable(str),
    platform: withMessage(is(isPlatform, 'a platform'), 'not a platform this build knows'),
  }),
  'expected a name, host, platform, description and repo',
)

/** Add a row. The refusal is the sentence the form shows under the fields. */
export const addExternalAppFn = adminFn
  .validator(asValidator(externalAppInput))
  .handler(async ({ data, context }): Promise<Result<ExternalApp>> => {
    const { addExternalApp } = await import('../core/settings/external-apps')
    return addExternalApp(await context.ctx(), data)
  })

/** Drop a row. The site keeps running wherever it runs; only the listing goes. */
export const removeExternalAppFn = adminFn
  .validator(asValidator(withMessage(obj({ id: str }), 'expected a row id')))
  .handler(async ({ data, context }): Promise<Result<null>> => {
    const { removeExternalApp } = await import('../core/settings/external-apps')
    const done = await removeExternalApp(await context.ctx(), data.id)
    return done ? { ok: true, value: null } : { ok: false, reason: 'No such row.' }
  })

// ── Settings › Developer › MCP tokens ──────────────────────────────────────
//
// The credentials that reach /mcp. Minting is a mutation like any other and
// goes through the same admin gate; the VALUE is returned exactly once, from
// this call, and is never recoverable afterwards — host/mcp/tokens.ts stores a
// digest. The panel shows it once and then forgets it too.

export const fetchMcpTokens = readFn.handler(async (): Promise<McpTokenRow[]> => {
  const { listMcpTokens } = await import('../host/mcp/tokens')
  return listMcpTokens()
})

const mcpTokenRequest = withMessage(
  obj({
    label: withMessage(str, 'expected a label'),
    scope: withMessage(is(isMcpScope, 'a scope'), 'scope must be read or write'),
  }),
  'expected a label and a scope',
)

/** Mint a token. The one call in this app whose response is a secret. */
export const mintMcpTokenFn = adminFn
  .validator(asValidator(mcpTokenRequest))
  .handler(async ({ data }): Promise<Result<{ row: McpTokenRow; token: string }>> => {
    const { mintMcpToken } = await import('../host/mcp/tokens')
    try {
      return { ok: true, value: await mintMcpToken(data) }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'could not mint the token' }
    }
  })

/** Revoke a token. The row stays, so its label still explains what it wrote. */
export const revokeMcpTokenFn = adminFn
  .validator(asValidator(withMessage(obj({ id: str }), 'expected a token id')))
  .handler(async ({ data }): Promise<Result<null>> => {
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

export const fetchAuthorization = readFn.handler(async (): Promise<AuthorizationView> => {
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
export const setEnforceAdminsFn = adminFn
  .validator(asValidator(withMessage(obj({ on: bool }), 'expected on: boolean')))
  .handler(async ({ data }): Promise<Result<null>> => {
    const { authorize, setEnforcingAdmins } = await import('../core/authz')
    return setEnforcingAdmins(data.on, await authorize())
  })
