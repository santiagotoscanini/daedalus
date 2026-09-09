// The error surface, at its two sizes.
//
// `ErrorPanel` is a whole page: the root route's errorComponent, reached when
// a loader or render throws with nothing nearer to catch it — the router's
// default there is a raw stack over a blank document. `AwaitError` is one
// section of a page: the streamed tabs resolve behind <Await>, and a rejected
// promise there would otherwise throw past its Suspense fallback and take the
// rest of the page with it.
//
// <Await> has no error slot in this router version (1.170.x), so
// `GuardedAwait` composes the router's CatchBoundary around it. The boundary
// resets when `resetKey` changes — which is what lets switching tabs clear a
// caught failure without a full reload.

import { Await, CatchBoundary, type ErrorComponentProps, useRouter } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { PageHead } from './page'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Retry, properly: invalidate FIRST, so the loaders run again, then reset the
 * boundary. Reset alone re-renders against the same rejected loader data and
 * lands straight back in the error state.
 */
function useRetry(reset: () => void) {
  const router = useRouter()
  return () => {
    void router.invalidate().then(() => {
      reset()
    })
  }
}

export function ErrorPanel({ error, reset }: ErrorComponentProps) {
  const retry = useRetry(reset)
  return (
    <>
      <PageHead title="Something broke">
        The page hit an error it could not render past. Reload re-runs its loaders; if it lands back
        here, the message below is where to start.
      </PageHead>
      <p className="my-3 font-mono text-danger text-sm break-words">{message(error)}</p>
      <p>
        <Button type="button" onClick={retry}>
          Reload
        </Button>
      </p>
    </>
  )
}

export function AwaitError({ error, reset }: ErrorComponentProps) {
  const retry = useRetry(reset)
  return (
    <Alert
      variant="destructive"
      className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2"
    >
      <span>
        This section failed to load.{' '}
        <span className="font-mono text-xs break-words">{message(error)}</span>
      </span>
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        Retry
      </Button>
    </Alert>
  )
}

/** Drop-in for a streamed `<Await>` whose failure should cost one section. */
export function GuardedAwait<T>({
  resetKey,
  promise,
  fallback,
  children,
}: {
  resetKey: string
  promise: Promise<T>
  fallback?: ReactNode
  children: (result: T) => ReactNode
}) {
  return (
    <CatchBoundary getResetKey={() => resetKey} errorComponent={AwaitError}>
      <Await promise={promise} fallback={fallback}>
        {children}
      </Await>
    </CatchBoundary>
  )
}
