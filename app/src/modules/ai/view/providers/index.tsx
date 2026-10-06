import { Link, useSearch } from '@tanstack/react-router'
import { OS_MARK } from '../../../../components/machine-head'
import {
  CAPTION,
  SEGMENT_ITEM,
  SEGMENT_ITEM_ON,
  SEGMENT_TRACK,
} from '../../../../components/tokens'
import { Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import type { ProviderMachine, ProvidersData } from '../../data/providers'
import { ChainBoard } from './chain'
import { BOX_MARK, MachineView } from './machine'

// The Providers tab: the chain once, then the picked machine in full.
//
// The picker is inside the tab rather than above the row — this is the one
// tab whose subject is several machines, and the other two are services on
// this box. Every machine's reading is in the payload, so a pick is a
// re-render; the URL carries it so a refresh and a link keep it.
//
// The models are grouped by KIND, because the constraint is per kind: one
// model of each may be resident, so a kind's models are competing answers
// to a single question rather than a flat list. That is also what makes the
// two buttons make sense — server/providers.ts says why a switch has to put
// the incumbent down first.

/* ── the picker ───────────────────────────────────────────────────────── */

/* Its own band, with air above and below: flush under the chain board it
   reads as a caption on it rather than as the control that decides
   everything below. The label earns its line for the same reason: a bare row
   of machine names does not say what picking one does. */
const PICKER = 'mt-6 mb-5 flex flex-wrap items-center gap-3'
const PICKER_LABEL = 'text-[0.75rem] text-muted-foreground'

function MachinePills({ machines, active }: { machines: ProviderMachine[]; active: string }) {
  return (
    <nav aria-label="Provider machine" className={PICKER}>
      <span className={PICKER_LABEL}>Machine</span>
      <div className={cn(SEGMENT_TRACK, 'overflow-x-auto')}>
        {machines.map((m) => {
          const mark = m.machine === 'box' ? BOX_MARK : OS_MARK[m.os]
          // Only when one machine runs more than one model server does the
          // kind belong in its name; otherwise it is a word repeated down the
          // row that distinguishes nothing.
          const ambiguous = machines.filter((o) => o.machine === m.machine).length > 1
          return (
            <Link
              key={m.id}
              to="/c/$category"
              params={{ category: 'ai' }}
              search={{ tab: 'providers', machine: m.id }}
              className={cn(SEGMENT_ITEM, active === m.id && SEGMENT_ITEM_ON)}
              aria-current={active === m.id ? 'page' : undefined}
            >
              {mark !== undefined && (
                <img
                  src={mark.src}
                  alt=""
                  width={14}
                  height={14}
                  className={cn('size-3.5', mark.invert && 'dark:invert')}
                />
              )}
              {m.name}
              {ambiguous && <span className="text-muted-foreground">· {m.kindName}</span>}
              <Pulse on={m.reachable} tone={m.reachable ? 'ok' : 'muted'} />
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

/* ── the tab ──────────────────────────────────────────────────────────── */

export function ProvidersView({ data }: { data: ProvidersData }) {
  const search = useSearch({ from: '/c/$category' })
  const wanted = search.machine ?? data.defaultMachine
  const active =
    data.machines.find((m) => m.id === wanted || m.machine === wanted) ?? data.machines[0]

  return (
    <>
      <ChainBoard chain={data.chain} />
      {data.machines.length === 0 ? (
        <p className={CAPTION}>
          No machine provides models yet. Approve one on Settings › Machines and offer its provider,
          or switch the tv stack on for this box's own.
        </p>
      ) : (
        <>
          {/* Matched by row id, not machine: the machine is only half of a
              row's identity (`<machine>:<kind>`). */}
          <MachinePills machines={data.machines} active={active?.id ?? ''} />
          {active !== undefined && <MachineView m={active} logs={data.logs} />}
        </>
      )}
    </>
  )
}
