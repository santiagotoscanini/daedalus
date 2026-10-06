// The GitHub App's two steps that change it: registering one, and the
// Apply a registration is waiting on.

import { useRouter } from '@tanstack/react-router'
import { useEffect, useId, useRef, useState } from 'react'
import type { GithubAppStatus } from '../../core/settings/types'
import {
  discardGithubPendingApplyFn,
  retryGithubApplyFn,
  startGithubAppFn,
} from '../../server/settings'
import { When } from '../ago'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { NOTE_SHOWN } from './form'
import { ERROR_NOTE, FIELD_LABEL, NOTE } from './shared'

type Launch = { action: string; manifest: string; state: string }

export function CreateApp({ app }: { app: GithubAppStatus }) {
  const id = useId()
  const [name, setName] = useState(app.defaultName)
  const { run, busy, error } = useAction()
  const [launch, setLaunch] = useState<Launch | null>(null)
  const launcher = useRef<HTMLFormElement>(null)

  // GitHub reads the manifest from a form body and answers with its own
  // confirmation page, so this has to be a top-level POST, not a fetch.
  useEffect(() => {
    if (launch !== null) launcher.current?.submit()
  }, [launch])

  // Back from GitHub without confirming: a page restored from the bfcache
  // still holds the launch, and with it a disabled button.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setLaunch(null)
    }
    window.addEventListener('pageshow', reset)
    return () => {
      window.removeEventListener('pageshow', reset)
    }
  }, [])

  const trimmed = name.trim()
  const tooLong = [...trimmed].length > app.nameMax
  const canCreate = !busy && launch === null && trimmed !== '' && !tooLong

  const create = () => {
    if (!canCreate) return
    run(() => startGithubAppFn({ data: { name: trimmed } }), {
      invalidate: false,
      onDone: (r) => {
        setLaunch(r.value)
      },
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <p className={NOTE}>
        The box registers an App of its own under {app.owner}. GitHub shows what the App may do and
        sends you back here once you confirm. Its private key and secrets are exchanged on the
        server and encrypted before they are applied; this page never holds them.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <label htmlFor={id} className={FIELD_LABEL}>
            App name
          </label>
          <Input
            id={id}
            value={name}
            maxLength={app.nameMax}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tooLong}
            onChange={(e) => {
              setName(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
        <Button type="submit" size="sm" className="h-9" disabled={!canCreate}>
          {busy || launch !== null ? 'Opening GitHub…' : 'Create GitHub App…'}
        </Button>
      </form>
      <p className={NOTE_SHOWN}>
        App names are unique across GitHub, {app.nameMax} characters at most.
      </p>
      {error !== null && (
        <p role="alert" className={ERROR_NOTE}>
          {error}
        </p>
      )}
      {launch !== null && (
        <form ref={launcher} method="post" action={launch.action} className="hidden">
          <input type="hidden" name="manifest" defaultValue={launch.manifest} />
          <input type="hidden" name="state" defaultValue={launch.state} />
        </form>
      )}
    </div>
  )
}

export function PendingApply({
  pending,
  owner,
  appsUrl,
}: {
  pending: NonNullable<GithubAppStatus['pending']>
  owner: string
  appsUrl: string
}) {
  const router = useRouter()
  const { run, busy, error, notice } = useAction()
  const [discarded, setDiscarded] = useState<string | null>(null)

  const discard = () => {
    run(() => discardGithubPendingApplyFn(), {
      invalidate: false,
      onDone: (r) => {
        setDiscarded(r.value.slug)
      },
    })
  }

  // Held on screen rather than refreshed away: the tab would redraw as if
  // nothing had happened, while the one step left is on GitHub.
  if (discarded !== null) {
    return (
      <Alert>
        <AlertTitle>Discarded {discarded}</AlertTitle>
        <AlertDescription>
          <p className="m-0">
            The box forgot its encrypted key and secrets, so it can no longer use this App. The App
            itself may still exist on GitHub: delete it from{' '}
            <a
              href={appsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {owner}’s GitHub Apps
            </a>{' '}
            if nothing else uses it, or its name stays taken.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void router.invalidate()
            }}
          >
            Done
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const retry = () => {
    run(() => retryGithubApplyFn(), {
      notice: 'Applying. Install the App once the rebuild finishes.',
    })
  }

  return (
    <Alert variant="warning">
      <AlertTitle>{pending.slug} exists on GitHub but has not been applied</AlertTitle>
      <AlertDescription>
        <p className="m-0">{pending.reason}</p>
        <p className="m-0">
          Its key and secrets are kept here, encrypted, since {<When at={pending.at} />}. Retry once
          nothing else is waiting to be applied, or discard them if this App is not the one to keep.
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={retry}>
            {busy ? 'Working…' : 'Retry Apply'}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={discard}>
            Discard
          </Button>
          {(error ?? notice) !== null && (
            <span className={error !== null ? ERROR_NOTE : NOTE_SHOWN}>{error ?? notice}</span>
          )}
        </div>
      </AlertDescription>
    </Alert>
  )
}
