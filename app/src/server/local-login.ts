import { createServerFn } from '@tanstack/react-start'
import type { LocalLoginState } from '../core/local-login'
import { isRecord } from '../lib/is-record'
import type { Result } from '../lib/result'

// Server functions behind /login — the break-glass local login
// (core/local-login.ts). These are the DOOR, so they are the one set of
// mutations in this app that is not behind assertAdmin(): a caller here has
// no identity yet, and getting one is the point. What gates them instead is
// site.json's `auth.localLogin`: off, every one of them throws before touching
// anything, and the page that would call them answers 404.
//
// Value imports are dynamic so argon2 and the database stay out of the client
// bundle, matching server/settings.ts.

/** The page's loader. Null means the route does not exist. */
export const fetchLocalLoginState = createServerFn().handler(
  async (): Promise<LocalLoginState | null> => {
    const { announceSetupTokenOnce, localLoginState } = await import('../core/local-login')
    const state = await localLoginState()
    // A fresh install's first visit may land before gatus has probed
    // /api/healthz; the token must exist by the time the form asks for it.
    if (state !== null && state.mode === 'setup') await announceSetupTokenOnce()
    return state
  },
)

const str = (d: Record<string, unknown>, k: string, max: number): string => {
  const v = d[k]
  if (typeof v !== 'string' || v.length > max) throw new Error(`expected ${k}`)
  return v
}

export const localSetupFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { token: string; username: string; password: string } => {
    if (!isRecord(data)) throw new Error('expected a setup form')
    return {
      token: str(data, 'token', 256),
      username: str(data, 'username', 64),
      password: str(data, 'password', 1024),
    }
  })
  .handler(async ({ data }): Promise<Result<null>> => {
    const { createFirstAdmin } = await import('../core/local-login')
    return createFirstAdmin(data)
  })

export const localLoginFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { username: string; password: string } => {
    if (!isRecord(data)) throw new Error('expected a login form')
    return { username: str(data, 'username', 64), password: str(data, 'password', 1024) }
  })
  .handler(async ({ data }): Promise<Result<null>> => {
    const { verifyLocalLogin } = await import('../core/local-login')
    return verifyLocalLogin(data)
  })

export const localLogoutFn = createServerFn({ method: 'POST' }).handler(async (): Promise<null> => {
  const { endLocalSession } = await import('../core/local-login')
  await endLocalSession()
  return null
})
