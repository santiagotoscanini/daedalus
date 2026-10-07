// Lemonade on one machine: the install the agent found and how it runs, what
// the box asks of it, and its last install — with the controls that change
// it (lifecycle-controls.tsx). Drawn for a node's Lemonade only; the box's own
// subgen is a container a rebuild manages.

import { CircleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Ago } from '../../../../components/ago'
import { FOOT, MONO, MONO_FACE } from '../../../../components/tokens'
import { Alert, AlertDescription } from '../../../../components/ui/alert'
import { Board, Chip, type Tone } from '../../../../components/viz'
import type { LifecyclePhase } from '../../../../host/controller/generated'
import { cn } from '../../../../lib/cn'
import { DASH } from '../../../../lib/format'
import {
  installText,
  type LifecycleFacts,
  processText,
  unmanagedInstall,
} from '../../../../lib/providers/lifecycle-text'
import { toneStyle } from '../../../../lib/tone'
import type { ProviderMachine } from '../../data/providers'
import { LifecycleControls, underWay } from './lifecycle-controls'

/* The facts on the left, read down; what changes them on the right. At a
   board this wide a six-across fact grid wrapped every value onto two lines. */
const SPLIT =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] items-start gap-x-10 gap-y-5 @max-[46rem]/board:grid-cols-1'

/* Key/value on a label column: the board is wide, so values sit left beside
   their labels rather than right-aligned a column-width away from them. */
const KV = 'm-0 grid grid-cols-[11rem_minmax(0,1fr)] content-start @max-[22rem]/board:grid-cols-1'
const KV_ROW =
  'col-span-2 grid grid-cols-subgrid items-baseline gap-x-4 @max-[22rem]/board:col-span-1 @max-[22rem]/board:gap-y-0.5 border-hairline border-t py-2 text-[0.8125rem] first:border-t-0 first:pt-0'

function KeyValues({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl className={KV}>
      {rows.map((r) => (
        <div key={r.k} className={KV_ROW}>
          <dt className="text-muted-foreground">{r.k}</dt>
          <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Two spellings of one release ("v2026.40.0", "2026.40.0") are the same release. */
const sameVersion = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && a.replace(/^v/, '') === b.replace(/^v/, '')

const STARTUP = { enabled: 'yes', disabled: 'no', missing: 'no entry' } as const

const PHASE: Record<LifecyclePhase, { label: string; tone: Tone }> = {
  downloading: { label: 'downloading', tone: 'info' },
  stopping: { label: 'stopping the server', tone: 'info' },
  installing: { label: 'installing', tone: 'info' },
  verifying: { label: 'verifying', tone: 'info' },
  wiring: { label: 'applying its settings', tone: 'info' },
  powering: { label: 'starting', tone: 'info' },
  rolling_back: { label: 'rolling back', tone: 'warn' },
  done: { label: 'installed', tone: 'ok' },
  failed: { label: 'failed', tone: 'bad' },
  rolled_back: { label: 'rolled back', tone: 'warn' },
}

/** The page's facts for the install and process lines (lib/providers/lifecycle-text.ts). */
function factsOf(m: ProviderMachine): LifecycleFacts {
  const g = m.managed
  return {
    speaks: m.speaksLifecycle,
    present: m.presence !== null,
    running: m.presence?.running === true,
    install: g?.install,
    pid: g?.pid,
    session: g?.session,
    owner: g?.owner,
  }
}

export function LifecycleBoard({ m }: { m: ProviderMachine }) {
  const g = m.managed
  const running = m.presence?.running === true
  const chip: { label: string; tone: Tone } = underWay(g?.lifecycle?.phase)
    ? { label: 'installing', tone: 'info' }
    : running
      ? { label: 'running', tone: 'ok' }
      : m.presence !== null
        ? { label: 'stopped', tone: 'muted' }
        : { label: 'not installed', tone: 'muted' }
  const facts = factsOf(m)
  const install = installText(facts)

  return (
    <Board
      title={`${m.kindName} on this machine`}
      icon="⚙"
      span={12}
      aside={<Chip tone={chip.tone}>{chip.label}</Chip>}
    >
      <div className={SPLIT}>
        <KeyValues
          rows={[
            {
              k: 'Install',
              v:
                install.tone === null ? (
                  install.text
                ) : (
                  <span className="text-(--tone)" style={toneStyle(install.tone)}>
                    {install.text}
                  </span>
                ),
            },
            { k: 'Version', v: m.version ?? DASH },
            // The installer and the pin only in their own words when they differ
            // from what runs: the same number four times down a board says it once.
            {
              k: 'Installer',
              v: sameVersion(g?.install?.installer_version, m.version)
                ? 'the same release'
                : (g?.install?.installer_version ?? DASH),
            },
            { k: 'Starts on its own', v: g?.startup == null ? DASH : STARTUP[g.startup] },
            { k: 'Process', v: processText(facts) },
            {
              k: 'Pinned release',
              v:
                m.asked?.pin == null
                  ? 'none'
                  : sameVersion(m.asked.pin, m.version)
                    ? 'this release'
                    : m.asked.pin,
            },
          ]}
        />
        <div className="flex min-w-0 flex-col gap-4">
          <Notices m={m} />
          <LifecycleControls m={m} />
          <LastInstall m={m} />
        </div>
      </div>
      <p className={FOOT}>
        The machine’s agent does the work: it downloads the pinned release from Lemonade’s own
        GitHub releases, checks its size and SHA-256, installs it silently, waits for the server to
        report the new version and rolls back to the last good installer when it does not. Start and
        Stop are kept: the agent starts it again if it stops, unless its user quit it.
      </p>
    </Board>
  )
}

/** The states that explain a button that does not work, said before anyone presses one. */
function Notices({ m }: { m: ProviderMachine }) {
  const g = m.managed
  const notes: string[] = []
  if (g?.noUserSession === true) {
    notes.push(
      'Nobody is logged on. On Windows the server lives in the user’s tray, so it serves only while someone is logged in; it starts again with the next logon.',
    )
  }
  if (g?.manualOff === true) {
    notes.push(
      'Its user quit it from the tray. It stays off until the next logon or a Start here; the agent does not fight it.',
    )
  }
  if (m.speaksLifecycle === false) {
    notes.push(
      'This machine’s agent is too old to report how Lemonade was installed and how it runs, or to install, update, start and stop it. Update the agent; this page fills in with its next report.',
    )
  }
  if (unmanagedInstall(factsOf(m))) {
    notes.push(
      'This server is not an install the agent can manage (no MSI or package record — an older installer). Uninstall it by hand once, then Install here; the models and settings in the profile stay.',
    )
  }
  if (notes.length === 0) return null
  return (
    <Alert variant="warning">
      <CircleAlertIcon />
      <AlertDescription>
        {notes.map((n) => (
          <p key={n} className="m-0">
            {n}
          </p>
        ))}
      </AlertDescription>
    </Alert>
  )
}

/* The installer's log: a disclosure, like a release entry. */
const LOG_SUMMARY =
  "cursor-pointer list-none text-[0.75rem] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden before:mr-1.5 before:content-['▸'] group-open:before:content-['▾']"
const LOG =
  'mt-2 max-h-[18rem] overflow-auto rounded-lg bg-foreground/[0.04] p-3 text-[0.72rem] leading-[1.5] text-subdued whitespace-pre-wrap'

/** The last install or update, as the agent's journal holds it. */
function LastInstall({ m }: { m: ProviderMachine }) {
  const l = m.managed?.lifecycle
  if (l == null) return null
  const p = PHASE[l.phase]
  return (
    <section className="border-hairline border-t pt-3">
      <div className="flex flex-wrap items-baseline gap-2 text-[0.8rem]">
        <span className="text-muted-foreground">Last install</span>
        <span className={cn(MONO, 'whitespace-nowrap')}>
          {l.from_version === null ? '' : `${l.from_version} → `}
          {l.version}
        </span>
        <Chip tone={p.tone}>{p.label}</Chip>
        <span className="text-[0.75rem] text-muted-foreground">
          <Ago at={l.at} />
        </span>
      </div>
      {/* "v2026.40.0 is running" after a done install restates the line above. */}
      {l.message !== '' &&
        !(l.phase === 'done' && sameVersion(l.message.split(' ')[0], m.version)) && (
          <p className="m-0 mt-1 text-[0.8rem] text-subdued">{l.message}</p>
        )}
      {l.vanished.length > 0 && (
        <Alert variant="warning" className="mt-2">
          <CircleAlertIcon />
          <AlertDescription>
            <p className="m-0">
              Gone from the catalog after this install, so the gateway names derived from them have
              nothing behind them: <span className={MONO}>{l.vanished.join(', ')}</span>.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {l.log_tail.length > 0 && (
        <details className="group mt-2">
          <summary className={LOG_SUMMARY}>Installer log, last {l.log_tail.length} lines</summary>
          <pre className={cn(MONO_FACE, LOG)}>{l.log_tail.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}
