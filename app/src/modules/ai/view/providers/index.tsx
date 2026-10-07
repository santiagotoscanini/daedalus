import { useSearch } from '@tanstack/react-router'
import { type MachineItem, MachineSwitcher } from '../../../../components/machine-picker'
import { CAPTION } from '../../../../components/tokens'
import type { ProviderMachine, ProvidersData } from '../../data/providers'
import { ChainBoard } from './chain'
import { MachineView, standingOf } from './machine'

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

/* THE machine picker (components/machine-picker.tsx), the same control System
   draws. A dot only where a machine's provider differs from the norm — not
   answering, not installed, no report yet — never a row of green. */
function MachinePills({ machines, active }: { machines: ProviderMachine[]; active: string }) {
  const items: MachineItem[] = machines.map((m) => {
    const standing = standingOf(m)
    // Only when one machine runs more than one model server does the kind
    // belong in its name; otherwise it is a word repeated down the row.
    const ambiguous = machines.filter((o) => o.machine === m.machine).length > 1
    return {
      key: m.id,
      label: m.name,
      os: m.machine === 'box' ? 'box' : m.os,
      selected: active === m.id,
      link: {
        to: '/c/$category',
        params: { category: 'ai' },
        search: { tab: 'providers', machine: m.id },
      },
      sub: ambiguous ? m.kindName : undefined,
      dot: standing.tone === 'ok' ? null : standing.tone,
      title: `${m.kindName}: ${standing.label}`,
    }
  })
  return <MachineSwitcher items={items} label="Provider machine" className="mt-6 mb-5" />
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
