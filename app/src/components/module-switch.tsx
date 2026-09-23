import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ModuleSwitch } from '../lib/module-switch'
import { nixModulesOf } from '../lib/modules/manifest'
import { moduleById } from '../lib/modules/registry'
import { useShown } from '../lib/shown'
import { fetchModuleSwitchFn, setModuleEnabledFn } from '../server/modules'
import { GHOST_BTN } from './apps/shared'
import { FOOT, MONO } from './tokens'
import { Button } from './ui/button'
import { Chip } from './viz'

// The switch at the foot of a service's page: the stack this tab fronts,
// on or off, and the one control that moves it.
//
// A move is a site edit — modules.enabled in site.json — and lands on the
// next Apply, so the control does two things and never a third: it asks,
// naming what the switch takes with it, and it writes the draft. The bar
// at the top of Apps is where the Apply happens, as for every other site
// change. A structural module has no button, only the reason.

type Draft = 'idle' | 'asking' | 'saving'

function Row({ m, onMoved }: { m: ModuleSwitch; onMoved: () => void }) {
  const router = useRouter()
  const [draft, setDraft] = useState<Draft>('idle')
  const [refused, setRefused] = useState<string | null>(null)
  const [desired, show] = useShown(m.desired, draft === 'saving', refused !== null)
  const pending = m.desired !== m.running

  const move = async (enabled: boolean) => {
    setDraft('saving')
    setRefused(null)
    show(enabled)
    const r = await setModuleEnabledFn({ data: { id: m.id, enabled } })
    if (!r.ok) setRefused(r.reason)
    setDraft('idle')
    onMoved()
    await router.invalidate()
  }

  return (
    <div className="border-(--border-soft) border-t pt-[0.6rem] text-[0.78rem]">
      <div className="flex flex-wrap items-center gap-[0.5rem]">
        <span className={MONO}>{m.id}</span>
        <Chip tone={desired ? 'ok' : 'muted'}>{desired ? 'on' : 'off'}</Chip>
        {pending && <Chip tone="warn">{m.desired ? 'on after Apply' : 'off after Apply'}</Chip>}
        <span className="text-muted-foreground">
          {m.containers.length} {m.containers.length === 1 ? 'container' : 'containers'}
          {m.hostnames.length > 0 && ` · ${m.hostnames.join(', ')}`}
        </span>
        <span className="ml-auto">
          {m.structural ? (
            <span className="text-muted-foreground">always on</span>
          ) : draft === 'asking' ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={GHOST_BTN}
              disabled={draft === 'saving'}
              onClick={() => (desired ? setDraft('asking') : void move(true))}
            >
              {desired ? 'Switch off' : 'Switch on'}
            </Button>
          )}
        </span>
      </div>
      {draft === 'asking' && (
        <div className="mt-[0.5rem] rounded-md border border-(--border-soft) bg-(--panel-2) p-[0.7rem]">
          <p className="m-0 text-[0.8rem] leading-[1.5]">
            Switching <b>{m.id}</b> off stops{' '}
            {m.containers.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <span className={MONO}>{c}</span>
              </span>
            ))}
            {m.hostnames.length > 0 && (
              <>
                ; <b>{m.hostnames.join(', ')}</b> {m.hostnames.length === 1 ? 'stops' : 'stop'}{' '}
                answering and {m.hostnames.length === 1 ? 'leaves' : 'leave'} the LAN's DNS
              </>
            )}
            ; this page leaves the rail. The data stays where it is under the state root, and the
            switch is one Apply away from on again.
          </p>
          <div className="mt-[0.5rem] flex gap-2">
            <Button type="button" size="sm" onClick={() => void move(false)}>
              Switch {m.id} off
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={GHOST_BTN}
              onClick={() => setDraft('idle')}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
      {refused !== null && <p className={`${FOOT} text-(--tone-bad)`}>{refused}</p>}
    </div>
  )
}

/**
 * The switches for the nix modules a module page's tab fronts. Fetched after
 * the boards, not with them: it is a footer, and the page must not wait on
 * it. Nothing is drawn while it loads or when the tab fronts no stack.
 */
export function ModuleSwitchFoot({ module, tab }: { module: string; tab: string }) {
  const spec = moduleById(module)
  const t = spec?.tabs.find((x) => x.id === tab)
  // Joined, so the effect keys on the ids and not on an array rebuilt per render.
  const key = t === undefined ? '' : nixModulesOf(t).join(',')
  const [rows, setRows] = useState<ModuleSwitch[] | null>(null)
  // Bumped after a move, so the rows say "off after Apply" at once.
  const [tick, setTick] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the refetch trigger, on purpose
  useEffect(() => {
    if (key === '') return
    let live = true
    void fetchModuleSwitchFn({ data: { ids: key.split(',') } }).then((r) => {
      if (live) setRows(r)
    })
    return () => {
      live = false
    }
  }, [key, tick])
  if (rows === null || rows.length === 0) return null
  return (
    <section className="mt-[1.4rem]">
      <h3 className="m-0 mb-[0.4rem] text-[0.85rem] [font-weight:550]">This service</h3>
      {rows.map((m) => (
        <Row key={m.id} m={m} onMoved={() => setTick((t) => t + 1)} />
      ))}
    </section>
  )
}
