import type { LocalLoginState } from '../core/local-login'
import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { strMax } from '../lib/contract/fields'
import type { Result } from '../lib/result'
import { publicFn, readFn } from './fn'

// Server functions behind /login, and the break-glass local login
// (core/local-login.ts). These are the DOOR, so they are the one set of
// mutations in this app that is `publicFn`, not `adminFn`: a caller here has
// no identity yet, and getting one is the point. What gates them instead is
// site.json's `auth.localLogin`: off, setup and login throw before touching
// anything, and logout does nothing.

/** What /login can offer this request. */
export type LoginState = {
  /** The identity provider's name, or null: none is configured. */
  provider: string | null
  /** The break-glass form's state, or null: site.json has it off. */
  local: LocalLoginState | null
  signedIn: boolean
}

/** The page's loader. */
export const fetchLoginState = readFn.handler(async (): Promise<LoginState> => {
  const { getRequest } = await import('@tanstack/react-start/server')
  const { signedIn } = await import('../core/authz')
  const { localLoginState } = await import('../core/local-login')
  const { oidcConfig } = await import('../core/oidc-config')
  const [local, session] = await Promise.all([localLoginState(), signedIn(getRequest())])
  return { provider: oidcConfig()?.name ?? null, local, signedIn: session }
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
