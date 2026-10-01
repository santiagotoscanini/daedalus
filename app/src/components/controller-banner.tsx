import { UnplugIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ControllerLink } from '../host/controller/client'
import { since } from '../lib/format'
import { fetchControllerLinkFn } from '../server/shell'
import { useNow, usePoll } from './poll'
import { Alert, AlertDescription } from './ui/alert'

// The one sentence for the most common failure on this box: the controller
// (the agent on the box) is not answering — every engine rebuild restarts it.
// Said once, above every page, so the boards that depend on it can say
// "unknown" instead of each guessing a verdict about the machines.
//
// Fetched on the client once the shell has mounted, then every few seconds;
// it lives in the shell, so a navigation neither remounts nor re-asks it.
// Nothing is drawn unless the link is down, so there is no loading state to
// flash.

const POLL_MS = 10_000

// A read that fails keeps the last answer: the banner is not the page's to break.
const read = (set: (l: ControllerLink) => void) =>
  fetchControllerLinkFn().then(set, () => undefined)

export function ControllerBanner() {
  const [link, setLink] = useState<ControllerLink | null>(null)
  useEffect(() => {
    void read(setLink)
  }, [])
  usePoll(() => read(setLink), POLL_MS, true)
  const now = useNow(link?.state === 'down')

  if (link?.state !== 'down') return null
  const at = Date.parse(link.since)
  return (
    <Alert variant="warning" className="mb-6">
      <UnplugIcon />
      <AlertDescription>
        <p className="m-0">
          <strong>Controller unreachable</strong>
          {now !== null && `, ${since((now - at) / 1000)}`}: {link.error}. Machine links, their
          Claude sessions and root actions read as unknown until it answers.
        </p>
      </AlertDescription>
    </Alert>
  )
}
