import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { Account, ProfilePatch, ProfileRead } from '../core/settings/types'
import { PICTURE_TYPES, type PictureType } from '../lib/profile-fields'

// Server functions behind Settings › Profile — see core/settings/profile.ts.
// Each resolves the account from the forward-auth headers of the request
// making it; none takes an account id from the page.
//
// Value imports are dynamic so the database and filesystem modules are not
// pulled into a client bundle, matching server/settings.ts.

const PATCH_KEYS = ['username', 'firstName', 'lastName', 'displayName', 'email'] as const

function who() {
  const header = (name: string) => {
    const v = getRequestHeader(name)
    return v === undefined || v === '' ? null : v
  }
  return { sub: header('x-forwarded-user'), email: header('x-forwarded-email') }
}

export const fetchProfile = createServerFn().handler(async (): Promise<ProfileRead> => {
  const { makeCtx } = await import('../core/ctx')
  const { readProfile } = await import('../core/settings/profile')
  return readProfile(await makeCtx(), who())
})

/**
 * The rail's account button, on every page. Never throws: a shell that cannot
 * say who is signed in still has to render, so any failure reads as "nobody".
 */
export const fetchAccount = createServerFn().handler(async (): Promise<Account | null> => {
  try {
    const { makeCtx } = await import('../core/ctx')
    const { readAccount } = await import('../core/settings/profile')
    return await readAccount(await makeCtx(), who())
  } catch {
    return null
  }
})

export const saveProfileFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): ProfilePatch => {
    if (data === null || typeof data !== 'object') throw new Error('not a profile edit')
    const out: ProfilePatch = {}
    for (const [k, v] of Object.entries(data)) {
      if (!(PATCH_KEYS as readonly string[]).includes(k))
        throw new Error(`${k} is not a profile field`)
      if (typeof v !== 'string') throw new Error(`${k} must be text`)
      out[k as (typeof PATCH_KEYS)[number]] = v
    }
    return out
  })
  .handler(async ({ data }): Promise<ProfileRead> => {
    const { makeCtx } = await import('../core/ctx')
    const { updateProfile } = await import('../core/settings/profile')
    return updateProfile(await makeCtx(), who(), data)
  })

export const uploadProfilePictureFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { contentType: PictureType; base64: string } => {
    const d = data as { contentType?: unknown; base64?: unknown } | null
    if (d === null || typeof d !== 'object') throw new Error('not a picture')
    if (!(PICTURE_TYPES as readonly unknown[]).includes(d.contentType)) {
      throw new Error('a PNG or JPEG is what Pocket ID accepts')
    }
    if (typeof d.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(d.base64)) {
      throw new Error('the picture did not arrive as base64')
    }
    return { contentType: d.contentType as PictureType, base64: d.base64 }
  })
  .handler(async ({ data }) => {
    const { makeCtx } = await import('../core/ctx')
    const { uploadPicture } = await import('../core/settings/profile')
    await uploadPicture(await makeCtx(), who(), data)
    return { ok: true as const }
  })

export const resetProfilePictureFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { makeCtx } = await import('../core/ctx')
  const { resetPicture } = await import('../core/settings/profile')
  await resetPicture(await makeCtx(), who())
  return { ok: true as const }
})
