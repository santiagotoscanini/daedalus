import { getRequestHeader } from '@tanstack/react-start/server'
import { AUTH_HEADERS } from '../core/auth'
import type { Account, OperatorAccount, ProfilePatch, ProfileRead } from '../core/settings/types'
import { asValidator, is, literal, obj, withMessage } from '../lib/contract/decode'
import { PICTURE_TYPES } from '../lib/profile-fields'
import { adminFn, readFn } from './fn'

// Server functions behind the Profile page — see core/settings/profile.ts.
// Each resolves the account from the forward-auth headers of the request
// making it; none takes an account id from the page.

// `satisfies` rather than a bare `as const`: a key here that ProfilePatch
// lacks is a compile error, not a validator that lets through a field
// updateProfile does not write. The other direction is not checked — a field
// added to ProfilePatch must be added here too, or a save refuses it.
const PATCH_KEYS = [
  'username',
  'firstName',
  'lastName',
  'displayName',
  'email',
] as const satisfies readonly (keyof ProfilePatch)[]

/**
 * The account this request is for: the forwarded subject and email, blank as
 * null. Not `context.actor()` — that is one display label with a
 * placeholder; the profile store keys on the two claims themselves.
 */
function who() {
  const header = (name: string) => {
    const v = getRequestHeader(name)
    return v === undefined || v === '' ? null : v
  }
  return { sub: header(AUTH_HEADERS.SUBJECT), email: header(AUTH_HEADERS.EMAIL) }
}

export const fetchProfile = readFn.handler(async ({ context }): Promise<ProfileRead> => {
  const { readProfile } = await import('../core/settings/profile')
  return readProfile(await context.ctx(), who())
})

/**
 * The rail's account button, on every page. Never throws: a shell that cannot
 * say who is signed in still has to render, so any failure reads as "nobody".
 */
export const fetchAccount = readFn.handler(async ({ context }): Promise<Account | null> => {
  try {
    const { readAccount } = await import('../core/settings/profile')
    return await readAccount(await context.ctx(), who())
  } catch {
    return null
  }
})

// Kept as a plain check rather than a decoder: the keys are open-ended, and
// each refusal names the key it refused.
export const saveProfileFn = adminFn
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
  .handler(async ({ data, context }): Promise<ProfileRead> => {
    const { updateProfile } = await import('../core/settings/profile')
    return updateProfile(await context.ctx(), who(), data)
  })

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const pictureUpload = withMessage(
  obj({
    contentType: withMessage(literal(...PICTURE_TYPES), 'a PNG or JPEG is what Pocket ID accepts'),
    base64: withMessage(
      is((v: unknown): v is string => typeof v === 'string' && BASE64.test(v), 'base64'),
      'the picture did not arrive as base64',
    ),
  }),
  'not a picture',
)

export const uploadProfilePictureFn = adminFn
  .validator(asValidator(pictureUpload))
  .handler(async ({ data, context }) => {
    const { uploadPicture } = await import('../core/settings/profile')
    await uploadPicture(await context.ctx(), who(), data)
    return { ok: true as const }
  })

export const resetProfilePictureFn = adminFn.handler(async ({ context }) => {
  const { resetPicture } = await import('../core/settings/profile')
  await resetPicture(await context.ctx(), who())
  return { ok: true as const }
})

/**
 * The Linux account the box runs as, for the Profile page's one card about
 * this machine. A file read, awaited like a fact.
 */
export const fetchOperator = readFn.handler(async (): Promise<OperatorAccount> => {
  const { siteIdentity } = await import('../host/contract/domains/site')
  const s = (await siteIdentity()).data
  return { user: s.operator.user, group: s.operator.group }
})
