// The Profile rows' checks, shared by the page (before a request is made) and
// the server functions (before Pocket ID is asked). The limits are Pocket ID's
// own — dto/user_dto.go, v2.14.0: username 1–50, first and last name 50,
// display name 100 — so a value refused here is one Pocket ID would refuse
// too, said before the round trip rather than after it.

/** Above this a JSON request stops being a reasonable way to carry a picture. */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024

export const PICTURE_TYPES = ['image/png', 'image/jpeg'] as const
export type PictureType = (typeof PICTURE_TYPES)[number]

export function usernameError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'a username is required.'
  if (v.length > 50) return 'at most 50 characters.'
  if (/\s/.test(v)) return 'no spaces.'
  return null
}

export function lengthError(max: number): (value: string) => string | null {
  return (value) => (value.trim().length > max ? `at most ${String(max)} characters.` : null)
}

export function pictureFileError(type: string, size: number): string | null {
  if (!(PICTURE_TYPES as readonly string[]).includes(type)) {
    return 'a PNG or JPEG — the two formats Pocket ID accepts.'
  }
  if (size > MAX_PICTURE_BYTES) {
    return `${(size / 1024 / 1024).toFixed(1)} MB is over the 5 MB this page sends.`
  }
  return null
}
