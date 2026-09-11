import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { TokenReplaceOutcome } from '../core/settings/cloudflare-token'
import type {
  BoxSettings,
  GeneralLive,
  GithubAppApply,
  GithubAppDiscard,
  GithubAppStart,
  GithubAppStatus,
  IntegrationStatus,
} from '../core/settings/types'
import type { SignInPoll, SignInStart } from '../lib/github-signin'
import { DEFAULT_THEME, isThemeChoice, presetById, type ThemeChoice } from '../lib/theme'

// Server functions behind Settings: the read-only facts (core/settings), the
// live integration checks, and the one preference that is editable. Values
// in the preference store never reach the site repo and never trigger a
// rebuild — see the `settings` table comment in lib/schema.ts for where that
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
 * General's deferred half: the zones the Cloudflare API token can see (the
 * domain picker) and where the NixOS release stands. Both ask services off the
 * box, so the tab renders its facts first and these stream in behind it.
 */
export const fetchGeneralLive = createServerFn().handler(async (): Promise<GeneralLive> => {
  const { makeCtx } = await import('../core/ctx')
  const { listZones } = await import('../core/settings/zones')
  const { nixosRelease } = await import('../core/settings/nixos')
  const { siteIdentity } = await import('../lib/contract/domains/site')
  const [ctx, site] = await Promise.all([makeCtx(), siteIdentity()])
  const [zones, nixos] = await Promise.all([listZones(ctx), nixosRelease(site.data.nixos)])
  return { zones, nixos }
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
    const { makeCtx } = await import('../core/ctx')
    const { replaceCloudflareToken } = await import('../core/settings/cloudflare-token')
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return replaceCloudflareToken(await makeCtx(), actor, data.token)
  })

/**
 * Settings › Integrations › GitHub › Sign in: the device flow's two halves
 * (core/settings/github-signin.ts). Neither answers with anything that could
 * redeem the sign-in — the page gets the code a person types, never the
 * device code, and never the token.
 */
export const startGithubSignInFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<SignInStart> => {
    const { makeCtx } = await import('../core/ctx')
    const { startGithubSignIn } = await import('../core/settings/github-signin')
    return startGithubSignIn(await makeCtx())
  },
)

export const pollGithubSignInFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { flow: string } => {
    const flow = (data as { flow?: unknown } | null)?.flow
    if (typeof flow !== 'string' || !/^[0-9a-f-]{36}$/.test(flow)) {
      throw new Error('expected a sign-in flow')
    }
    return { flow }
  })
  .handler(async ({ data }): Promise<SignInPoll> => {
    const { makeCtx } = await import('../core/ctx')
    const { pollGithubSignIn } = await import('../core/settings/github-signin')
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return pollGithubSignIn(await makeCtx(), actor, data.flow)
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
    const { makeCtx } = await import('../core/ctx')
    const { actorFrom, startAppCreation } = await import('../core/settings/github-app')
    // No fallback name: a missing identity is null, and every App mutation refuses it.
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
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
    const { makeCtx } = await import('../core/ctx')
    const { actorFrom, pasteAppKey } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    return pasteAppKey(await makeCtx(), actor, data)
  })

export const retryGithubApplyFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<GithubAppApply> => {
    const { makeCtx } = await import('../core/ctx')
    const { actorFrom, retryPendingApply } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    return retryPendingApply(await makeCtx(), actor)
  },
)

/**
 * Forget a created App's pending Apply. The enabled flag and the actor are
 * checked in core/settings/github-app.ts, like every other App mutation.
 */
export const discardGithubPendingApplyFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<GithubAppDiscard> => {
    const { makeCtx } = await import('../core/ctx')
    const { actorFrom, discardPendingApply } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    return discardPendingApply(await makeCtx(), actor)
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
    const { writeSetting, SETTING_KEYS } = await import('../lib/repo/settings')
    await writeSetting(SETTING_KEYS.theme, data)
    return data
  })
