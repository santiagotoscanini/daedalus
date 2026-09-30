import { createFileRoute } from '@tanstack/react-router'
import { LaptopIcon } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import { Measure, PageHead } from '../components/page'
import { ERROR_NOTE, FIELD_LABEL, Mono, NOTE, Section } from '../components/settings/shared'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import type { EnrollPage } from '../host/enroll'
import { TYPED_LENGTH, typedMatches } from '../lib/agent/enroll'
import { errorText } from '../lib/redact'
import { confirmEnrollFn, fetchEnrollPageFn } from '../server/enroll'

// A Mac logs in (agent/README.md "Logging in (macOS)"; host/enroll.ts is the
// flow). The menu bar's "Log in…" opens this page with the Mac's key, a
// loopback port and the log-in's state; the admin compares the fingerprint
// with the menu bar, types its first characters, and confirms or declines.
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
    <Measure>
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
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [spent, setSpent] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [busy, start] = useTransition()
  const matches = typedMatches(m.fingerprint, typed)

  const confirm = () => {
    setError(null)
    start(async () => {
      try {
        const r = await confirmEnrollFn({ data: { token: page.token, typed } })
        if (!r.ok) {
          // Spent unless the box refused before it looked at the token: a
          // second try then starts from the menu bar.
          setSpent(r.retry !== true)
          setError(r.reason)
          return
        }
        setSpent(true)
        setLeaving(true)
        goTo(r.value.callback)
      } catch (e) {
        setSpent(true)
        setError(errorText(e))
      }
    })
  }

  return (
    <>
      <PageHead title={`Log in ${m.name}`}>
        Confirm only if the menu bar of the Mac in front of you shows this fingerprint right now.
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
        <p className={NOTE}>
          Confirm lets this Mac join the box's VPN with a tunnel of its own, through which it links
          to the box. Once santree is on for it in Settings › Machines, that is also a shell on the
          box.
        </p>
        {STANDING[page.standing] !== null && <p className={NOTE}>{STANDING[page.standing]}</p>}
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (matches && !busy && !spent) confirm()
          }}
        >
          <label className={FIELD_LABEL} htmlFor={inputId}>
            The first {TYPED_LENGTH} characters of the fingerprint in the menu bar
          </label>
          <Input
            id={inputId}
            className="max-w-[10rem] font-mono"
            value={typed}
            maxLength={9}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            autoFocus
            disabled={spent}
            onChange={(e) => setTyped(e.target.value)}
          />
          {error !== null && <p className={ERROR_NOTE}>{error}</p>}
          {leaving && <p className={NOTE}>Handing over to the Mac…</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!matches || busy || spent}>
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
        </form>
      </Section>
    </>
  )
}
