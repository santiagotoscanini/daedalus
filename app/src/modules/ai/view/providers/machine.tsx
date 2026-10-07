// One machine in full: its head, its actions, its models and what it offers.

import { LogBoard, type LogNeighbour } from '../../../../components/logs'
import { HeadStrip, OS_MARK, WipBoard } from '../../../../components/machine-head'
import { FOOT, MONO } from '../../../../components/tokens'
import { Button } from '../../../../components/ui/button'
import { BoardGrid, Measures } from '../../../../components/viz'
import type { ProviderMachine, ProvidersData } from '../../data/providers'
import { LifecycleBoard } from './lifecycle'
import { ModelsBoard } from './models'

/* ── one machine ──────────────────────────────────────────────────────── */

/** Where a kind documents itself. Nothing here is about a particular machine. */
const KIND_LINKS: Partial<Record<ProviderMachine['kind'], { label: string; href: string }[]>> = {
  lemonade: [
    { label: 'API docs', href: 'https://lemonade-server.ai/docs/api/lemonade/' },
    { label: 'Model library', href: 'https://lemonade-server.ai/docs/server/server_models/' },
    { label: 'GitHub', href: 'https://github.com/lemonade-sdk/lemonade' },
  ],
}

/* Under the head, hanging past the artwork so it lines up with the name —
   the same row a service page's LinkRow draws. */
const DOCS =
  '-mt-2 mb-6 ml-[3.625rem] flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] max-[44rem]:ml-0'
const DOC_LINK =
  'text-muted-foreground no-underline transition-colors hover:text-foreground hover:no-underline'

/**
 * The provider's own window, on the right of the head where every service
 * page keeps its open button.
 *
 * It goes to the provider's published hostname (`m.ui`, behind the sign-in
 * gate), drawn only while it answers. Everything the page does to a model it
 * does through a server function (server/providers.ts says why), so this link
 * is for the things the page deliberately does not do — registering a
 * checkpoint, installing a backend, deleting weights.
 */
function OpenProvider({ m }: { m: ProviderMachine }) {
  const open = m.reachable ? m.ui : null
  if (open === null) return null
  return (
    <Button asChild size="sm" className="mt-1.5 flex-none">
      <a href={open} target="_blank" rel="noreferrer">
        Open {m.kindName} ↗
      </a>
    </Button>
  )
}

/** Where the provider's kind is documented. */
function DocLinks({ m }: { m: ProviderMachine }) {
  const docs = KIND_LINKS[m.kind] ?? []
  if (docs.length === 0) return <div className="mb-2" />
  return (
    <p className={DOCS}>
      {docs.map((l) => (
        <a key={l.href} className={DOC_LINK} href={l.href} target="_blank" rel="noreferrer">
          {l.label} ↗
        </a>
      ))}
    </p>
  )
}

/**
 * The bridge is diagnostics for the model server's panel, not a service
 * anybody watches — so it gets the same treatment as every other
 * neighbour.
 */
const LOG_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'lemonade-logs' },
    label: 'Bridge logs',
    role: 'the process shipping the above',
    title: 'Log bridge',
    note: 'Deliberately a separate stream: this is the bridge’s own reconnects and gap warnings, and mixing them into the model server’s log would make it look like it was reporting network trouble it knows nothing about. Look here when the panel above goes quiet.',
  },
]

export function MachineView({ m, logs }: { m: ProviderMachine; logs: ProvidersData['logs'] }) {
  return (
    <>
      <div className="flex items-start gap-4 max-[44rem]:flex-wrap">
        <div className="min-w-0 flex-auto">
          <MachineHead m={m} />
        </div>
        <OpenProvider m={m} />
      </div>
      <DocLinks m={m} />

      <BoardGrid>
        {/* Lemonade on a machine: install, update, power. The box's own subgen
            is a container a rebuild manages. */}
        {m.machine !== 'box' && m.kind === 'lemonade' && <LifecycleBoard m={m} />}

        {/* Only for a machine that has an agent to wait on. This box has
            none, and its provider runs on the CPU. */}
        {m.machine !== 'box' && (
          <WipBoard title="GPU right now" span={12} waits="waits on the agent’s GPU live figures">
            <Measures
              items={[
                { k: 'Load', v: '41%' },
                { k: 'Memory', v: '13.2 of 24 GB' },
                { k: 'Die', v: '61 °C' },
                { k: 'Clock', v: '2,410 MHz' },
              ]}
            />
          </WipBoard>
        )}

        <ModelsBoard m={m} />

        {/* One bridge, one target — see `logsFor` in ../../data/providers.ts. */}
        {logs?.machine === m.machine && (
          <LogBoard
            source={{ stack: logs.stack }}
            title={`${m.kindName} logs`}
            foot={
              <p className={FOOT}>
                The model server’s own log, streamed off the machine over its{' '}
                <code>/logs/stream</code> WebSocket and pushed to Loki by the bridge below.
                Timestamps are the ones the server recorded, not the ones Loki received.
              </p>
            }
            neighbours={LOG_NEIGHBOURS}
          />
        )}
      </BoardGrid>
    </>
  )
}

/** The strip above the boards: the machine, its provider and how it stands. */
function MachineHead({ m }: { m: ProviderMachine }) {
  // A machine nothing offers and no agent has seen is not a fault: it is a
  // provider not installed yet, and the line says what installing it does.
  const absent =
    m.reported && !m.reachable && !m.offered && m.presence === null && m.machine !== 'box'
  const chip = m.reachable
    ? { label: 'answering', tone: 'ok' as const }
    : !m.reported
      ? { label: 'no report yet', tone: 'muted' as const }
      : absent
        ? { label: 'not installed', tone: 'muted' as const }
        : { label: 'not answering', tone: 'bad' as const }
  const presence =
    m.presence === null
      ? m.machine === 'box'
        ? 'a service of the tv stack'
        : m.reported
          ? 'the agent finds none'
          : 'the gateway keeps the routes it has'
      : m.presence.running
        ? `the agent sees it running${m.presence.version === null ? '' : ` · v${m.presence.version}`}`
        : 'the agent sees it installed but not running'
  return (
    <HeadStrip
      mark={m.machine === 'box' ? BOX_MARK : OS_MARK[m.os]}
      name={m.name}
      chip={chip}
      aside={`${m.kindName}${m.version === null ? '' : ` ${m.version}`}`}
      line={
        <>
          <span className={MONO}>{m.base}</span> · {presence} ·{' '}
          {m.offered ? 'offered to the gateway' : 'not offered to the gateway'}
          {m.error !== null && !absent && ` · ${m.error}`}
          {absent &&
            ` · install ${m.kindName}${m.os === 'macos' ? ' for macOS (Metal)' : ''} on it and offer it on Settings › Machines`}
        </>
      }
    />
  )
}

export const BOX_MARK = { src: '/icon-nixos.webp', invert: false }
