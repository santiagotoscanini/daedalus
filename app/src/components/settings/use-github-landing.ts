import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { GithubAppStatus, GithubCallbackNotice } from '../../core/settings/types'
import { fetchGithubAppStatus, githubInstallLandedFn } from '../../server/settings'
import { usePoll } from '../poll'

// What Settings does when GitHub sends the operator back: the App manifest
// callback's verdict (`?github=…&reason=…`), or GitHub's own redirect after an
// install (`?setup_action=…`). Each arrives in the query once; this holds it as
// a notice, drops the query, and after an install watches the App's status
// until the host's minter has seen it. The page calls it above the GuardedAwait
// that remounts the Integrations tab, so the notice survives that remount.

/** How long the GitHub App section keeps asking after an install, and how often. */
const INSTALL_WATCH_MS = 60_000
const INSTALL_POLL_MS = 5_000

/** The query /settings validates: the tab plus what GitHub's redirects add. */
export type GithubLandingSearch = {
  tab?: string
  github?: Exclude<GithubCallbackNotice['github'], 'installed'>
  reason?: string
  setup_action?: 'install' | 'update'
}

export function useGithubLanding(
  search: GithubLandingSearch,
  githubApp: GithubAppStatus | null,
): {
  app: GithubAppStatus | null
  notice: GithubCallbackNotice | null
  onDismissNotice: () => void
} {
  const router = useRouter()

  // The GitHub callback's verdict, or GitHub's install redirect, arrives in
  // the query once. It is held here, above the Await that remounts the tab
  // when the live checks land, and the query is dropped so a reload does not
  // repeat it.
  const landed = search.setup_action !== undefined
  const [githubNotice, setGithubNotice] = useState<GithubCallbackNotice | null>(() =>
    search.github !== undefined
      ? { github: search.github, code: search.reason ?? null }
      : landed
        ? { github: 'installed', code: null }
        : null,
  )
  useEffect(() => {
    if (search.github === undefined && search.reason === undefined && !landed) return
    void router.navigate({
      to: '/settings',
      search: { tab: landed ? 'integrations' : search.tab },
      replace: true,
    })
  }, [search.github, search.reason, search.tab, landed, router])

  // After an install the host's minter has not looked yet, so the App reads
  // "not installed". Ask it to look now, then re-read the App's status every
  // few seconds for a minute, so "installed" arrives without a reload.
  const [watchUntil, setWatchUntil] = useState<number | null>(null)
  // Tagged with the loader read it was polled over: a fresh loader read is
  // newer than anything the poll held, so a stale tag falls back to it.
  const [polled, setPolled] = useState<{
    over: typeof githubApp
    status: GithubAppStatus
  } | null>(null)
  const askedMinter = useRef(false)
  useEffect(() => {
    if (!landed || askedMinter.current) return
    askedMinter.current = true
    void githubInstallLandedFn()
      .then((r) => {
        if (r.ok) setWatchUntil(Date.now() + INSTALL_WATCH_MS)
      })
      .catch(() => {})
  }, [landed])
  const loaderApp = useRef(githubApp)
  loaderApp.current = githubApp
  usePoll(
    async () => {
      // Re-read rather than closed over: `usePoll` calls the newest closure,
      // so this is the current deadline and not the one the watch started with.
      if (watchUntil === null) return
      try {
        const s = await fetchGithubAppStatus()
        setPolled({ over: loaderApp.current, status: s })
        if (s.state === 'installed' || Date.now() >= watchUntil) setWatchUntil(null)
      } catch {
        if (Date.now() >= watchUntil) setWatchUntil(null)
      }
    },
    INSTALL_POLL_MS,
    watchUntil !== null,
  )

  return {
    app: polled !== null && polled.over === githubApp ? polled.status : githubApp,
    notice: githubNotice,
    onDismissNotice: () => {
      setGithubNotice(null)
    },
  }
}
