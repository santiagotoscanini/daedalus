import { useRouter, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { PendingApply } from '../host/pending-apply'
import { fetchPendingApply } from '../server/registry'
import { ApplyBar } from './apply-bar'

// The Apply bar for every page that does not draw its own.
//
// Site edits are made from more places than the pages that used to carry the
// bar — a service's cog on any module page, a game server's roster — and an
// edit whose Apply button lives on another page is an edit that looks like it
// did nothing. So the root layout draws the bar too, fed by the whole of what
// the next Apply would do (host/pending-apply.ts).
//
// Fetched on the client, after the page, and again whenever the router
// resolves — every navigation, and every `router.invalidate()`, which is what
// each edit control calls after saving. The pages with a bar of their own
// (the app list and an app's page, Settings) keep it: theirs is fed by their
// loader, and two bars would stack.

const ownsBar = (path: string) =>
  path === '/apps' || path.startsWith('/apps/') || path.startsWith('/settings')

export function PendingApplyBar() {
  const router = useRouter()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const [data, setData] = useState<PendingApply | null>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      fetchPendingApply()
        .then((d) => {
          if (live) setData(d)
        })
        // A bar that could not be read is no bar; the page is not its to break.
        .catch(() => undefined)
    }
    load()
    const unsubscribe = router.subscribe('onResolved', load)
    return () => {
      live = false
      unsubscribe()
    }
  }, [router])

  if (data === null || ownsBar(path)) return null
  return <ApplyBar changed={data.changed} initialStatus={data.status} />
}
