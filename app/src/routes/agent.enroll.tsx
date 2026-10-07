import { createFileRoute } from '@tanstack/react-router'
import { LaptopIcon } from 'lucide-react'
import { useState } from 'react'
import { Measure, PageHead } from '../components/page'
import { ERROR_NOTE, Mono, NOTE_SHOWN, Section } from '../components/settings/shared'
import { Button } from '../components/ui/button'
import { useAction } from '../components/use-action'
import type { EnrollPage } from '../host/enroll'
import { confirmEnrollFn, fetchEnrollPageFn } from '../server/enroll'

// A Mac logs in (agent/README.md "Logging in (macOS)"; host/enroll.ts is the
// flow). The menu bar's "Log in…" opens this page with the Mac's key, a
// loopback port and the log-in's state: a consent page that names the Mac and
// shows its full key, where the admin confirms or declines. Confirm is a
// button, not a form, so a click before the page hydrated does nothing.
// Either way the browser goes back to the Mac's loopback, which is waiting.
//
// The loader's answer is held from the first render on: it was computed for
// the page load the menu bar opened (its token is minted once), and a later
// reload of the loader answers for a router fetch, which is no page at all.

export const Route = createFileRoute('/agent/enroll')({
  loader: () => fetchEnrollPageFn(),
  staleTime: Number.POSITIVE_INFINITY,
  component: EnrollRoute,
})

function EnrollRoute() {
  const [page] = useState<EnrollPage>(Route.useLoaderData())
  return (
    <Measure className="max-w-[40rem]">
      <EnrollView page={page} />
    </Measure>
  )
}

/** Back to the Mac, which waits on its loopback for the answer. */
const goTo = (url: string) => window.location.assign(url)

function EnrollView({ page }: { page: EnrollPage }) {
  switch (page.kind) {
    case 'invalid':
      return (
        <PageHead title="This is not a log-in link">
          {`Its address is not one the menu bar makes (${page.reason}). To log a Mac in, choose Log in… in its menu bar.`}
        </PageHead>
      )
    case 'unavailable':
      return (
        <>
          <PageHead title="Logging in is not available yet">
            {`This box cannot give ${page.name} a tunnel yet, so it cannot log in here. Nothing was changed.`}
          </PageHead>
          <div>
            <Button variant="outline" onClick={() => goTo(page.declineUrl)}>
              Tell the Mac
            </Button>
          </div>
        </>
      )
    case 'forbidden':
      return (
        <>
          <PageHead title="Only an admin can log a Mac in">
            {`${page.reason} Ask an admin to choose Log in… in ${page.name}'s menu bar and confirm it.`}
          </PageHead>
          <div>
            <Button variant="outline" onClick={() => goTo(page.declineUrl)}>
              Decline
            </Button>
          </div>
        </>
      )
    case 'refused':
      return (
        <>
          <PageHead title="Open this from the menu bar">
            {`This page can only confirm a log-in the Mac's menu bar opened: ${page.reason}. Choose Log in… in ${page.name}'s menu bar again.`}
          </PageHead>
          <div>
            <Button variant="outline" onClick={() => goTo(page.declineUrl)}>
              Decline
            </Button>
          </div>
        </>
      )
    case 'ready':
      return <ConfirmView page={page} />
  }
}

const STANDING: Record<Extract<EnrollPage, { kind: 'ready' }>['standing'], string | null> = {
  new: null,
  approved: 'The box already trusts this Mac. Confirming gives it a new tunnel.',
  revoked: 'The box revoked this Mac before. Confirming trusts it again.',
}

function ConfirmView({ page }: { page: Extract<EnrollPage, { kind: 'ready' }> }) {
  const m = page.machine
  const [spent, setSpent] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const { run, busy, error } = useAction()

  const confirm = () => {
    if (busy || spent) return
    run(
      async () => {
        // Spent unless the box refused before it looked at the token: a
        // second try then starts from the menu bar.
        setSpent(true)
        const r = await confirmEnrollFn({ data: { token: page.token } })
        if (!r.ok && r.retry === true) setSpent(false)
        return r
      },
      {
        invalidate: false,
        onDone: (r) => {
          setLeaving(true)
          goTo(r.value.callback)
        },
      },
    )
  }

  return (
    <>
      <PageHead title={`Log in ${m.name}`}>
        Confirm only if you just asked for this from that machine.
      </PageHead>
      <Section
        title={m.name}
        icon={<LaptopIcon />}
        description={`${m.os} · ${m.arch} · agent ${m.version}`}
        rows={[
          { k: 'Fingerprint', v: <Mono>{m.fingerprint}</Mono> },
          { k: 'Node', v: <Mono>{m.id}</Mono> },
        ]}
      >
        <p className={NOTE_SHOWN}>
          Confirm lets this Mac join the box's VPN with a tunnel of its own, through which it links
          to the box. Once santree is on for it in Settings › Machines, that is also a shell on the
          box.
        </p>
        {STANDING[page.standing] !== null && (
          <p className={NOTE_SHOWN}>{STANDING[page.standing]}</p>
        )}
        {error !== null && <p className={ERROR_NOTE}>{error}</p>}
        {leaving && <p className={NOTE_SHOWN}>Handing over to the Mac…</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy || spent} onClick={confirm}>
            Confirm
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || leaving}
            onClick={() => goTo(page.declineUrl)}
          >
            Decline
          </Button>
        </div>
      </Section>
    </>
  )
}
