import { createFileRoute, redirect } from '@tanstack/react-router'
import { KeyRoundIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { ERROR_NOTE, FIELD_LABEL, Mono, NOTE_SHOWN } from '../components/settings/shared'
import { Button, buttonVariants } from '../components/ui/button'
import { Card, CardContent, CardHeader } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { useAction } from '../components/use-action'
import type { LocalLoginState } from '../core/local-login'
import { safeNext } from '../lib/safe-next'
import { fetchLoginState, localLoginFn, localLogoutFn, localSetupFn } from '../server/local-login'

// Where a visitor with no session lands (core/request-gate.ts).
//
// With only an identity provider there is nothing to choose, so the loader goes
// straight to it and this page is never drawn. It draws when there is something
// to say: the visitor just signed out and must not be signed back in, a sign-in
// failed, or site.json's `auth.localLogin` offers the break-glass form too.
//
// The frame is bare (routes/__root.tsx): this page has no session behind it, so
// nothing from the shell belongs in its HTML. For the same reason a read does
// not work from here, and leaving is always a full page load, never the router.

/** A label above its field. */
const FIELD = 'flex flex-col gap-1.5'

const startHref = (next: string) => `/api/auth/start?next=${encodeURIComponent(next)}`

export const Route = createFileRoute('/login')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { next?: string; error?: string; signedOut?: boolean } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
    // A code, never text: Auth.js's word for what went wrong.
    error:
      typeof search.error === 'string' && /^[A-Za-z]{1,40}$/.test(search.error)
        ? search.error
        : undefined,
    signedOut: search.signedOut === 1 || search.signedOut === '1' ? true : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const state = await fetchLoginState()
    const next = safeNext(deps.next)
    if (state.signedIn) throw redirect({ href: next, reloadDocument: true })
    const quiet = deps.error === undefined && deps.signedOut !== true
    if (state.provider !== null && state.local === null && quiet) {
      throw redirect({ href: startHref(next), reloadDocument: true })
    }
    return state
  },
  component: LoginPage,
})

/** What a failed sign-in says. The rest of Auth.js's codes all mean the same to a person. */
const failure = (code: string) =>
  code === 'AccessDenied'
    ? 'That account is not in the admins group, so it cannot use this box.'
    : 'The sign-in did not finish. Try again, or check Settings › Sign-in.'

function LoginPage() {
  const { provider, local } = Route.useLoaderData()
  const { next, error, signedOut } = Route.useSearch()
  const target = safeNext(next)
  const setup = local?.mode === 'setup'
  const title = local === null ? 'Sign in' : setup ? 'Create the first admin' : 'Local sign-in'

  return (
    // A card centred on the canvas: the first thing anyone sees, so it is
    // the one page drawn as a single object — the mark, the title, the form.
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-[24rem] gap-6 py-7">
        <CardHeader className="justify-items-center gap-3 text-center">
          <img
            src="/icon.svg"
            alt=""
            width={44}
            height={44}
            className="size-11 rounded-[11px] shadow-[inset_0_1px_0_var(--hairline-hi)]"
          />
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[1.25rem] leading-tight tracking-[-0.02em] [font-weight:620]">
              {title}
            </h1>
            {signedOut === true && <p className={NOTE_SHOWN}>You are signed out.</p>}
            {local !== null && (
              <p className="m-0 text-[0.82rem] text-muted-foreground leading-relaxed">
                {setup
                  ? 'No local admin exists yet. The setup token was printed to the server journal at its last start.'
                  : 'The break-glass door: a password, for when the identity provider is not there.'}
              </p>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {error !== undefined && <p className={ERROR_NOTE}>{failure(error)}</p>}
          {provider !== null && (
            <a href={startHref(target)} className={buttonVariants({ className: 'w-full' })}>
              Sign in with {provider}
            </a>
          )}
          {provider === null && local === null && (
            <p className={NOTE_SHOWN}>
              No way to sign in is configured on this box. Set an identity provider, or turn on{' '}
              <Mono>auth.localLogin</Mono> in <Mono>site.json</Mono>, then rebuild.
            </p>
          )}
          {local !== null && <LocalForm state={local} target={target} />}
        </CardContent>
      </Card>
    </div>
  )
}

/** The break-glass form. Until the first admin exists it is the setup. */
function LocalForm({ state, target }: { state: LocalLoginState; target: string }) {
  const ids = { token: useId(), user: useId(), pass: useId() }
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { run, busy, error } = useAction()
  const setup = state.mode === 'setup'

  const submit = () => {
    run(
      () =>
        setup
          ? localSetupFn({ data: { token, username, password } })
          : localLoginFn({ data: { username, password } }),
      {
        invalidate: false,
        onDone: () => {
          setPassword('')
          window.location.assign(target)
        },
      },
    )
  }

  const signOut = () => {
    run(() => localLogoutFn(), {
      invalidate: false,
      onDone: () => {
        window.location.assign('/login?signedOut=1')
      },
    })
  }

  return (
    <>
      {state.signedInAs !== null && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-surface-raised px-3.5 py-2.5">
          <p className={NOTE_SHOWN}>
            Signed in as <Mono>local:{state.signedInAs}</Mono>.
          </p>
          <Button variant="outline" size="sm" disabled={busy} onClick={signOut}>
            Sign out
          </Button>
        </div>
      )}

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {setup && (
          <div className={FIELD}>
            <label className={FIELD_LABEL} htmlFor={ids.token}>
              Setup token
            </label>
            <Input
              id={ids.token}
              value={token}
              autoComplete="off"
              placeholder="dsetup_…"
              className="font-mono"
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        )}
        <div className={FIELD}>
          <label className={FIELD_LABEL} htmlFor={ids.user}>
            Username
          </label>
          <Input
            id={ids.user}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className={FIELD}>
          <label className={FIELD_LABEL} htmlFor={ids.pass}>
            Password
          </label>
          <Input
            id={ids.pass}
            type="password"
            value={password}
            autoComplete={setup ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error !== null && <p className={ERROR_NOTE}>{error}</p>}
        <Button
          type="submit"
          className="mt-1 w-full"
          disabled={busy || username === '' || password === ''}
        >
          <KeyRoundIcon aria-hidden="true" />
          {setup ? 'Create admin and sign in' : 'Sign in'}
        </Button>
      </form>

      <p className="m-0 border-hairline border-t pt-4 text-center text-[0.75rem] text-muted-foreground">
        Writes made from this session are recorded as <Mono>local:&lt;username&gt;</Mono>, and a
        local admin is implicitly in <Mono>admins</Mono>.
      </p>
    </>
  )
}
