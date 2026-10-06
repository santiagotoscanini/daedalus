import { UnplugIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ControllerLink } from '../host/controller/client'
import { controllerSkew } from '../lib/controller-version'
import { since } from '../lib/format'
import { fetchControllerLinkFn } from '../server/shell'
import { useNow, usePoll } from './poll'
import { Alert, AlertDescription } from './ui/alert'

// The one sentence for the most common failure on this box: the controller
// (the agent on the box) is not answering — every engine rebuild restarts it.
// Said once, above every page, so the boards that depend on it can say
// "unknown" instead of each guessing a verdict about the machines. And the
// one for a controller that answers in another release than the one this
// app was built beside (lib/controller-version.ts).
//
// Fetched on the client once the shell has mounted, then every few seconds;
// it lives in the shell, so a navigation neither remounts nor re-asks it.
// Nothing is drawn while the link holds and agrees, so there is no loading state to
// flash.

const POLL_MS = 10_000

// A calm inline notice, not a loud bar: the tint and the hairline carry the
// tone, the sentence stays in body ink so it reads as text.
const CALM =
  'mb-6 rounded-xl border-warning/25 bg-warning/8 px-4 py-3 text-foreground [&>svg]:text-warning'
const CALM_BODY =
  'text-[0.84rem] text-muted-foreground opacity-100 [&_strong]:text-foreground [&_strong]:[font-weight:560]'

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

  if (link?.state === 'connected') {
    const skew = controllerSkew(link.version)
    if (skew === null) return null
    return (
      <Alert variant="warning" className={CALM}>
        <UnplugIcon />
        <AlertDescription className={CALM_BODY}>
          <p className="m-0">
            <strong>Controller out of date</strong>: it runs agent {skew.runs}, and this app was
            built beside {skew.ships}. Applying the engine brings them together; until then, an
            answer the two do not share fails rather than reading as a guess.
          </p>
        </AlertDescription>
      </Alert>
    )
  }
  if (link?.state !== 'down') return null
  const at = Date.parse(link.since)
  return (
    <Alert variant="warning" className={CALM}>
      <UnplugIcon />
      <AlertDescription className={CALM_BODY}>
        <p className="m-0">
          <strong>Controller unreachable</strong>
          {now !== null && `, ${since((now - at) / 1000)}`}: {link.error}. Machine links, their
          Claude sessions and root actions read as unknown until it answers.
        </p>
      </AlertDescription>
    </Alert>
  )
}
