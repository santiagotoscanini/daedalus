import { errorText } from '../lib/redact'
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
import { type ReactNode, useEffect, useReducer, useState } from 'react'
import { PageHead } from './page'
import { Alert } from './ui/alert'
import { Button } from './ui/button'

function message(error: unknown): string {
  return errorText(error)
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

/**
 * Nothing lives at this address.
 *
 * Its own component rather than the router's default, for two reasons. The
 * default is a bare `<p>Not Found</p>` outside the shell's typography, and the
 * router warns on the server for every request that reaches it — which on this
 * box is every browser asking for `/favicon.ico`, so the warning was most of
 * what the log said. Not an error: there is nothing to retry and nothing to
 * report, so it offers the one useful thing, the way back.
 */
export function NotFoundPanel() {
  return (
    <>
      <PageHead title="Nothing here">
        No page lives at this address. It may have been renamed, or the link was typed by hand.
      </PageHead>
      <p>
        <Button asChild>
          <a href="/apps">Back to Apps</a>
        </Button>
      </p>
    </>
  )
}

function AwaitError({ error, reset }: ErrorComponentProps) {
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

/**
 * Drop-in for a streamed `<Await>` whose failure should cost one section —
 * and which, once it has answered, never shows its skeleton again.
 *
 * Every loader hands the page NEW promises, on purpose: the frame renders
 * the instant you click and the boards stream in behind it. The cost was
 * that a page you had already read streamed in again — the router keeps
 * its loader result for `defaultStaleTime`, but past that (or on a reload
 * it decided to run) the section got a fresh promise, suspended, and the
 * skeleton flashed over content that was on screen a second ago. What the
 * eye expects from a native app is the opposite: what you saw last time,
 * at once, and the new answer replacing it in place if it differs.
 *
 * So a section remembers its last result, in this module, keyed by the
 * caller's `resetKey` (which every page builds from the tab and the subject)
 * plus its `slot` — the name a page gives a section when it draws several
 * behind one key. On the client, a section with a
 * memory renders it immediately and settles the new promise in an effect;
 * a section without one — the first visit, and every server render — goes
 * through `<Await>` as before, which is what keeps SSR streaming intact and
 * the skeleton honest: it means "never loaded", not "loading again".
 *
 * The memory is per browser tab, unbounded, and never read on the server —
 * a server-side map would hand one person's page to the next.
 */
export function GuardedAwait<T>({
  resetKey,
  slot = 'main',
  promise,
  fallback,
  children,
}: {
  resetKey: string
  /** Which of the page's sections this is, when several share a key. */
  slot?: string
  promise: Promise<T>
  fallback?: ReactNode
  children: (result: T) => ReactNode
}) {
  return (
    <CatchBoundary getResetKey={() => resetKey} errorComponent={AwaitError}>
      <Settled cacheKey={`${resetKey}#${slot}`} promise={promise} fallback={fallback}>
        {children}
      </Settled>
    </CatchBoundary>
  )
}

const settled = new Map<string, unknown>()

function Settled<T>({
  cacheKey,
  promise,
  fallback,
  children,
}: {
  cacheKey: string
  promise: Promise<T>
  fallback?: ReactNode
  children: (result: T) => ReactNode
}) {
  // Whether the effect below may run at all: on the server there is no memory,
  // and on the client's first render after hydration there is none either, so
  // both go through <Await> and agree.
  const remembered = typeof window !== 'undefined' && settled.has(cacheKey)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const [failure, setFailure] = useState<{ promise: Promise<T>; error: unknown } | null>(null)

  useEffect(() => {
    if (!remembered) return
    let live = true
    promise.then(
      (value) => {
        if (!live) return
        settled.set(cacheKey, value)
        rerender()
      },
      (error: unknown) => {
        if (live) setFailure({ promise, error })
      },
    )
    return () => {
      live = false
    }
  }, [remembered, promise, cacheKey])

  // A refresh that failed is worth the section, as a first load that failed
  // is: stale numbers presented as current would be the worse lie.
  if (remembered && failure !== null && failure.promise === promise) throw failure.error

  // One <Await> in both cases, so the children keep their place in the
  // tree. A remembered section used to render them bare, and the first
  // refresh after a first sight moved them from inside <Await> to outside
  // it — a remount, which threw away every input and switch state below
  // and re-ran every effect. React's `use` returns at once from a thenable
  // already marked fulfilled, which is what the memory hands it.
  return (
    <Await
      promise={remembered ? fulfilled(settled.get(cacheKey) as T) : promise}
      fallback={fallback}
    >
      {(value) => {
        // Written during render, which is safe for an idempotent map write, and
        // the only place the first answer passes through.
        if (!remembered && typeof window !== 'undefined') settled.set(cacheKey, value)
        return children(value)
      }}
    </Await>
  )
}

/** A promise `use` will not suspend on: settled, and saying so. */
function fulfilled<T>(value: T): Promise<T> {
  const p = Promise.resolve(value) as Promise<T> & { status?: string; value?: T }
  p.status = 'fulfilled'
  p.value = value
  return p
}
