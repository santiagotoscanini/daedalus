import type { LocalLoginState } from '../core/local-login'
import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { strMax } from '../lib/contract/fields'
import type { Result } from '../lib/result'
import { publicFn, readFn } from './fn'

// Server functions behind /login — the break-glass local login
// (core/local-login.ts). These are the DOOR, so they are the one set of
// mutations in this app that is `publicFn`, not `adminFn`: a caller here has
// no identity yet, and getting one is the point. What gates them instead is
// site.json's `auth.localLogin`: off, every one of them throws before touching
// anything, and the page that would call them answers 404.
//
// Value imports are dynamic so argon2 and the database stay out of the client
// bundle, matching server/settings.ts.

/** The page's loader. Null means the route does not exist. */
export const fetchLocalLoginState = readFn.handler(async (): Promise<LocalLoginState | null> => {
  const { announceSetupTokenOnce, localLoginState } = await import('../core/local-login')
  const state = await localLoginState()
  // A fresh install's first visit may land before gatus has probed
  // /api/healthz; the token must exist by the time the form asks for it.
  if (state !== null && state.mode === 'setup') await announceSetupTokenOnce()
  return state
})

/** A form field of at most `max` characters, refused as `expected <field>`. */
const field = (name: string, max: number) => withMessage(strMax(max), `expected ${name}`)

const setupForm = withMessage(
  obj({
    token: field('token', 256),
    username: field('username', 64),
    password: field('password', 1024),
  }),
  'expected a setup form',
)

const loginForm = withMessage(
  obj({ username: field('username', 64), password: field('password', 1024) }),
  'expected a login form',
)

// publicFn: the door itself — no identity exists yet to be an admin with.
// core/local-login.ts refuses every call while site.json's switch is off.
export const localSetupFn = publicFn
  .validator(asValidator(setupForm))
  .handler(async ({ data }): Promise<Result<null>> => {
    const { createFirstAdmin } = await import('../core/local-login')
    return createFirstAdmin(data)
  })

// publicFn: signing in is how a caller gets an identity (see localSetupFn).
export const localLoginFn = publicFn
  .validator(asValidator(loginForm))
  .handler(async ({ data }): Promise<Result<null>> => {
    const { verifyLocalLogin } = await import('../core/local-login')
    return verifyLocalLogin(data)
  })

// publicFn: signing out must work for a session whatever its groups say.
export const localLogoutFn = publicFn.handler(async (): Promise<null> => {
  const { endLocalSession } = await import('../core/local-login')
  await endLocalSession()
  return null
})
