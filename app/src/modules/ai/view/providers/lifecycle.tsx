// Lemonade on one machine: the install the agent found and how it runs, what
// the box asks of it, and its last install — with the controls that change
// it (lifecycle-controls.tsx). Drawn for a node's Lemonade only; the box's own
// subgen is a container a rebuild manages.

import { CircleAlertIcon } from 'lucide-react'
import { Ago } from '../../../../components/ago'
import { FOOT, MONO, MONO_FACE } from '../../../../components/tokens'
import { Alert, AlertDescription } from '../../../../components/ui/alert'
import { Board, Chip, Measures, type Tone } from '../../../../components/viz'
import type { LifecyclePhase, ProviderInstall } from '../../../../host/controller/generated'
import { cn } from '../../../../lib/cn'
import { DASH } from '../../../../lib/format'
import type { ProviderMachine } from '../../data/providers'
import { LifecycleControls, underWay } from './lifecycle-controls'

const METHOD: Record<ProviderInstall['method'], string> = {
  msi: 'MSI',
  pkg: 'macOS package',
  deb: '.deb package',
  rpm: '.rpm package',
}

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

function installText(i: ProviderInstall | null | undefined, present: boolean): string {
  if (i == null) return present ? 'not one the agent can manage' : 'none'
  const scope =
    i.scope === 'machine' ? 'per machine' : `per user${i.user === null ? '' : ` (${i.user})`}`
  return `${METHOD[i.method]} · ${scope}`
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
  const process =
    g?.pid == null
      ? 'not running'
      : [
          `pid ${String(g.pid)}`,
          ...(g.session === null ? [] : [`session ${String(g.session)}`]),
          ...(g.owner === null ? [] : [g.owner]),
        ].join(' · ')

  return (
    <Board
      title={`${m.kindName} on this machine`}
      icon="⚙"
      span={12}
      aside={<Chip tone={chip.tone}>{chip.label}</Chip>}
    >
      <Measures
        items={[
          {
            k: 'install',
            v: installText(g?.install, m.presence !== null),
            ...(g !== null && g.install === null && m.presence !== null ? { tone: 'warn' } : {}),
          },
          { k: 'version', v: m.version ?? DASH },
          { k: 'installer', v: g?.install?.installer_version ?? DASH },
          { k: 'starts on its own', v: g?.startup == null ? DASH : STARTUP[g.startup] },
          { k: 'process', v: process },
          { k: 'pinned release', v: m.asked?.pin ?? 'none' },
        ]}
      />
      <Notices m={m} />
      <LifecycleControls m={m} />
      <LastInstall m={m} />
      <p className={cn(FOOT, 'mt-[0.8rem]')}>
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
  if (g !== null && g.install === null && m.presence !== null) {
    notes.push(
      'This server is not an install the agent can manage (no MSI or package record — an older installer). Uninstall it by hand once, then Install here; the models and settings in the profile stay.',
    )
  }
  if (notes.length === 0) return null
  return (
    <Alert variant="warning" className="mt-[0.8rem]">
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
  "cursor-pointer list-none text-[0.72rem] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden before:mr-[0.35rem] before:content-['▸'] group-open:before:content-['▾']"
const LOG =
  'mt-[0.4rem] max-h-[18rem] overflow-auto rounded-[7px] bg-raised p-[0.6rem] text-[0.7rem] leading-[1.45] text-subdued whitespace-pre-wrap'

/** The last install or update, as the agent's journal holds it. */
function LastInstall({ m }: { m: ProviderMachine }) {
  const l = m.managed?.lifecycle
  if (l == null) return null
  const p = PHASE[l.phase]
  return (
    <section className="mt-[0.9rem] border-subtle border-t pt-[0.7rem]">
      <div className="flex flex-wrap items-baseline gap-[0.5rem] text-[0.78rem]">
        <span className="text-muted-foreground">Last install</span>
        <span className={MONO}>
          {l.from_version === null ? '' : `${l.from_version} → `}
          {l.version}
        </span>
        <Chip tone={p.tone}>{p.label}</Chip>
        <span className="text-[0.7rem] text-muted-foreground">
          <Ago at={l.at} />
        </span>
      </div>
      {l.message !== '' && (
        <p className="m-0 mt-[0.3rem] text-[0.78rem] text-subdued">{l.message}</p>
      )}
      {l.vanished.length > 0 && (
        <Alert variant="warning" className="mt-[0.5rem]">
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
        <details className="group mt-[0.4rem]">
          <summary className={LOG_SUMMARY}>Installer log, last {l.log_tail.length} lines</summary>
          <pre className={cn(MONO_FACE, LOG)}>{l.log_tail.join('\n')}</pre>
        </details>
      )}
    </section>
  )
}
