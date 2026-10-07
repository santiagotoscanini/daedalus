import { cn } from '../../lib/cn'
import { type ModuleSwitch, STRUCTURAL_WHY } from '../../lib/module-switch'
import { useShown } from '../../lib/shown'
import { setModuleEnabledFn } from '../../server/modules'
import { ServiceSettingsButton } from '../service-settings'
import { CELL_QUIET, TABLE_HEAD, TABLE_ROW } from '../table'
import { Switch } from '../ui/switch'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import { Mono, NOTE, SECTIONS, Section } from './shared'

// Settings › Modules: every switch the box declares, in one table. The same
// move as the cog on a service's page (components/service-settings.tsx),
// without the walk there; a structural module is a row that says why it stays.
//
// Read down the columns: the module, where it answers, the cog, the switch.
// What every row shares — the domain under each hostname, "on" — recedes;
// what differs (a module off, a change waiting for Apply, a refusal) is ink.

/** Module, where it answers, the cog, the switch — head and rows alike. */
const GRID =
  'grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_2rem_3.5rem] items-center gap-x-6 px-5 @max-[40rem]/table:grid-cols-[minmax(0,1fr)_2rem_3.5rem]'
/** The column that steps away on a narrow table. */
const STEP = '@max-[40rem]/table:hidden'

const why = (id: string): string => STRUCTURAL_WHY[id] ?? 'a running box cannot do without it'

/** `jellyfin.example.com` → `jellyfin` in ink and the shared domain receding. */
function Host({ name }: { name: string }) {
  const dot = name.indexOf('.')
  if (dot <= 0) return <span>{name}</span>
  return (
    <span>
      <span className="text-subdued">{name.slice(0, dot)}</span>
      <span className="text-muted-foreground/60">{name.slice(dot)}</span>
    </span>
  )
}

/** Where a module answers: its hostnames, or how many containers it pins. */
function Where({ m }: { m: ModuleSwitch }) {
  if (m.hostnames.length > 0) {
    return (
      <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[0.78rem]">
        {m.hostnames.map((h) => (
          <Host key={h} name={h} />
        ))}
      </span>
    )
  }
  return (
    <span className={CELL_QUIET}>
      {m.containers.length === 0
        ? 'no pinned container'
        : `${String(m.containers.length)} ${m.containers.length === 1 ? 'container' : 'containers'}`}
    </span>
  )
}

function Row({ m }: { m: ModuleSwitch }) {
  const { run, busy: saving, error: refused } = useAction()
  const [on, show] = useShown(m.desired, saving, refused !== null)
  const pending = m.desired !== m.running
  return (
    <li className={cn(GRID, TABLE_ROW)}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Mono className={cn('truncate', on ? 'text-foreground' : 'text-muted-foreground')}>
          {m.id}
        </Mono>
        {pending && <Chip tone="warn">{m.desired ? 'on after Apply' : 'off after Apply'}</Chip>}
        {refused !== null && <span className="text-[0.78rem] text-danger">{refused}</span>}
      </span>
      <span className={cn('min-w-0', STEP, !on && 'opacity-60')}>
        <Where m={m} />
      </span>
      <ServiceSettingsButton ids={[m.id]} size="xs" />
      <span className="flex justify-end">
        <Switch
          aria-label={`${m.id} on`}
          checked={on}
          disabled={saving}
          onCheckedChange={(v) => {
            show(v)
            run(() => setModuleEnabledFn({ data: { id: m.id, enabled: v } }))
          }}
        />
      </span>
    </li>
  )
}

export function Modules({ rows }: { rows: ModuleSwitch[] }) {
  const structural = rows.filter((m) => m.structural)
  const flippable = rows.filter((m) => !m.structural)
  const moved = rows.filter((m) => m.switched)
  return (
    <div className={SECTIONS}>
      <Section
        title="Services"
        description="The stacks this box can run or set aside. A switch lands on the next Apply."
        aside={
          <>
            {String(flippable.length)} can be switched · {String(structural.length)} always on
            {moved.length > 0 && ` · ${String(moved.length)} moved by hand`}
          </>
        }
        body={
          <ul className="m-0 list-none p-0">
            <li className={cn(GRID, TABLE_HEAD)}>
              <span>Module</span>
              <span className={STEP}>Answers at</span>
              <span />
              <span className="text-right">On</span>
            </li>
            {flippable.map((m) => (
              <Row key={m.id} m={m} />
            ))}
          </ul>
        }
      >
        <p className={NOTE}>
          A switch is a line in site.json, <Mono>modules.enabled</Mono>, and lands on the next
          Apply: the stack's containers stop, its hostnames stop answering, its tab stays in the
          rail greyed, its data stays under the state root. Off is one Apply from on again. The cog
          holds the rest: where each hostname answers, and whether the tunnel carries it (
          <Mono>modules.web</Mono>).
        </p>
      </Section>

      <Section
        title="Always on"
        description="What a running box cannot do without, and why each one stays."
        body={
          <ul className="m-0 list-none p-0">
            <li className={cn(GRID, TABLE_HEAD)}>
              <span>Module</span>
              <span className={STEP}>Why it stays</span>
              <span />
              <span />
            </li>
            {structural.map((m) => (
              <li key={m.id} className={cn(GRID, TABLE_ROW)}>
                <span title={why(m.id)} className="min-w-0 truncate">
                  <Mono className="text-foreground">{m.id}</Mono>
                </span>
                <span className={cn(CELL_QUIET, STEP, 'truncate')}>{why(m.id)}</span>
                <ServiceSettingsButton ids={[m.id]} size="xs" />
                <span />
              </li>
            ))}
          </ul>
        }
      >
        <p className={NOTE}>
          The engine's spine plus what this host adds in its own files (
          <Mono>fleet.structuralModules</Mono>). Naming one off in site.json fails the build.
        </p>
      </Section>
    </div>
  )
}
