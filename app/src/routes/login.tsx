import { createFileRoute, notFound, useRouter } from '@tanstack/react-router'
import { KeyRoundIcon } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import { PageHead } from '../components/page'
import { ERROR_NOTE, FIELD_LABEL, Mono, NOTE, PANEL } from '../components/settings/shared'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { errorText } from '../lib/redact'
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
  const [error, setError] = useState<string | null>(null)
  const [busy, start] = useTransition()

  const submit = () => {
    setError(null)
    start(async () => {
      try {
        const r =
          state.mode === 'setup'
            ? await localSetupFn({ data: { token, username, password } })
            : await localLoginFn({ data: { username, password } })
        if (!r.ok) {
          setError(r.reason)
          return
        }
        setPassword('')
        await router.navigate({ to: '/apps' })
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  const signOut = () => {
    start(async () => {
      await localLogoutFn()
      await router.invalidate()
    })
  }

  return (
    <div className="mx-auto flex max-w-[28rem] flex-col gap-6">
      <PageHead title={state.mode === 'setup' ? 'Create the first admin' : 'Local sign-in'}>
        {state.mode === 'setup'
          ? 'No local admin exists yet. The setup token was printed to the server journal at its last start.'
          : 'The break-glass door: a password, for when the identity provider is not there.'}
      </PageHead>

      {state.signedInAs !== null && (
        <div className={PANEL}>
          <p className={NOTE}>
            Signed in as <Mono>local:{state.signedInAs}</Mono>.
          </p>
          <div>
            <Button variant="outline" size="sm" disabled={busy} onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      )}

      <form
        className={PANEL}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <span className="inline-flex items-center gap-2 font-medium text-[0.82rem]">
          <KeyRoundIcon className="size-4 text-(--text-muted)" />
          {state.mode === 'setup' ? 'Setup' : 'Sign in'}
        </span>
        {state.mode === 'setup' && (
          <>
            <label className={FIELD_LABEL} htmlFor={ids.token}>
              Setup token
            </label>
            <Input
              id={ids.token}
              value={token}
              autoComplete="off"
              placeholder="dsetup_…"
              onChange={(e) => setToken(e.target.value)}
            />
          </>
        )}
        <label className={FIELD_LABEL} htmlFor={ids.user}>
          Username
        </label>
        <Input
          id={ids.user}
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
        <label className={FIELD_LABEL} htmlFor={ids.pass}>
          Password
        </label>
        <Input
          id={ids.pass}
          type="password"
          value={password}
          autoComplete={state.mode === 'setup' ? 'new-password' : 'current-password'}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error !== null && <p className={ERROR_NOTE}>{error}</p>}
        <div>
          <Button type="submit" size="sm" disabled={busy || username === '' || password === ''}>
            {state.mode === 'setup' ? 'Create admin and sign in' : 'Sign in'}
          </Button>
        </div>
        <p className={NOTE}>
          Writes made from this session are recorded as <Mono>local:&lt;username&gt;</Mono>, and a
          local admin is implicitly in <Mono>admins</Mono>.
        </p>
      </form>
    </div>
  )
}
