import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { KeyRoundIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { NOTE_SHOWN } from '../components/settings/form'
import { ERROR_NOTE, FIELD_LABEL, Mono } from '../components/settings/shared'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { useAction } from '../components/use-action'
import {
  fetchLocalLoginState,
  localLoginFn,
  localLogoutFn,
  localSetupFn,
} from '../server/local-login'

// The break-glass local login (core/local-login.ts).
//
// This route exists only while site.json's `auth.localLogin` is true. Off,
// the loader throws notFound() and the answer is a 404 — the same page an
// unknown path gets — rather than a form that says "disabled": a door that
// is not there tells a visitor nothing about whether one could be.
//
// Two shapes of the one form. Until the first admin exists the form is the
// setup: the token the server printed to its journal, plus the username and
// password to create. After that it is a login. The server decides which by
// its own state, not by anything the page sends.

/** A label above its field. */
const FIELD = 'flex flex-col gap-1.5'

export const Route = createFileRoute('/login')({
  loader: async () => {
    const state = await fetchLocalLoginState()
    if (state === null) throw notFound()
    return state
  },
  component: LoginPage,
})

function LoginPage() {
  const state = Route.useLoaderData()
  const router = useRouter()
  const ids = { token: useId(), user: useId(), pass: useId() }
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const { run, busy, error } = useAction()

  const submit = () => {
    run(
      () =>
        state.mode === 'setup'
          ? localSetupFn({ data: { token, username, password } })
          : localLoginFn({ data: { username, password } }),
      {
        invalidate: false,
        onDone: () => {
          setPassword('')
          return router.navigate({ to: '/apps' })
        },
      },
    )
  }

  const signOut = () => {
    run(() => localLogoutFn())
  }

  const setup = state.mode === 'setup'

  return (
    // A card centred on the canvas: the first thing anyone sees, so it is
    // the one page drawn as a single object — the mark, the title, the form.
    <div className="flex min-h-[calc(100dvh-10rem)] items-center justify-center py-10">
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
              {setup ? 'Create the first admin' : 'Local sign-in'}
            </h1>
            <p className="m-0 text-[0.82rem] text-muted-foreground leading-relaxed">
              {setup
                ? 'No local admin exists yet. The setup token was printed to the server journal at its last start.'
                : 'The break-glass door: a password, for when the identity provider is not there.'}
            </p>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5">
          {state.signedInAs !== null && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-foreground/[0.03] px-3 py-2.5">
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

          <p className="m-0 border-hairline border-t pt-4 text-center text-[0.75rem] text-muted-foreground leading-relaxed">
            Writes made from this session are recorded as <Mono>local:&lt;username&gt;</Mono>, and a
            local admin is implicitly in <Mono>admins</Mono>.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
