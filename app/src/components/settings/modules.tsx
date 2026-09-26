import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { type ModuleSwitch, STRUCTURAL_WHY } from '../../lib/module-switch'
import { useShown } from '../../lib/shown'
import { setModuleEnabledFn } from '../../server/modules'
import { ServiceSettingsButton } from '../service-settings'
import { FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../tokens'
import { Switch } from '../ui/switch'
import { Board, BoardGrid, Chip } from '../viz'

// Settings › Modules: every switch the box declares, in one list. The same
// move as the cog on a service's page (components/service-settings.tsx),
// without the walk there; a structural module is a row that says why it stays.

function Row({ m }: { m: ModuleSwitch }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [on, show] = useShown(m.desired, saving, refused !== null)
  const pending = m.desired !== m.running
  return (
    <li className={ROW}>
      <span className={ROW_MAIN}>
        <span className={MONO}>{m.id}</span>
        {pending && (
          <span className="ml-[0.5rem]">
            <Chip tone="warn">{m.desired ? 'on after Apply' : 'off after Apply'}</Chip>
          </span>
        )}
        {refused !== null && <span className="ml-[0.4rem] text-(--tone-bad)">{refused}</span>}
      </span>
      <span className={ROW_SIDE}>
        {m.hostnames.length > 0
          ? m.hostnames.join(', ')
          : m.containers.length === 0
            ? 'no pinned container'
            : `${String(m.containers.length)} ${m.containers.length === 1 ? 'container' : 'containers'}`}
      </span>
      <ServiceSettingsButton ids={[m.id]} size="xs" />
      {m.structural ? (
        <span
          className="min-w-[4.5rem] text-right text-[0.7rem] text-muted-foreground"
          title={STRUCTURAL_WHY[m.id] ?? 'a running box cannot do without it'}
        >
          always on
        </span>
      ) : (
        <Switch
          aria-label={`${m.id} on`}
          checked={on}
          disabled={saving}
          onCheckedChange={(v) => {
            setSaving(true)
            setRefused(null)
            show(v)
            void setModuleEnabledFn({ data: { id: m.id, enabled: v } }).then(async (r) => {
              if (!r.ok) setRefused(r.reason)
              setSaving(false)
              await router.invalidate()
            })
          }}
        />
      )}
    </li>
  )
}

export function Modules({ rows }: { rows: ModuleSwitch[] }) {
  const structural = rows.filter((m) => m.structural)
  const flippable = rows.filter((m) => !m.structural)
  const moved = rows.filter((m) => m.switched)
  return (
    <BoardGrid>
      <Board
        title="Services"
        icon="rows"
        span={12}
        aside={
          <span className={NOTE}>
            {String(flippable.length)} can be switched · {String(structural.length)} always on
            {moved.length > 0 && ` · ${String(moved.length)} moved by hand`}
          </span>
        }
      >
        <ul className={LIST}>
          {flippable.map((m) => (
            <Row key={m.id} m={m} />
          ))}
        </ul>
        <p className={FOOT}>
          A switch is a line in site.json, <span className={MONO}>modules.enabled</span>, and lands
          on the next Apply: the stack's containers stop, its hostnames stop answering, its tab
          stays in the rail greyed, its data stays under the state root. Off is one Apply from on
          again. The cog holds the rest: where each hostname answers, and whether the tunnel carries
          it (<span className={MONO}>modules.web</span>).
        </p>
      </Board>
      <Board title="Always on" icon="warn" span={12}>
        <ul className={LIST}>
          {structural.map((m) => (
            <li key={m.id} className={ROW}>
              <span className={ROW_MAIN}>
                <span className={MONO}>{m.id}</span>
              </span>
              <span className={ROW_SIDE}>
                {STRUCTURAL_WHY[m.id] ?? 'a running box cannot do without it'}
              </span>
              <ServiceSettingsButton ids={[m.id]} size="xs" />
            </li>
          ))}
        </ul>
        <p className={FOOT}>
          The engine's spine plus what this host adds in its own files (
          <span className={MONO}>fleet.structuralModules</span>). Naming one off in site.json fails
          the build.
        </p>
      </Board>
    </BoardGrid>
  )
}
