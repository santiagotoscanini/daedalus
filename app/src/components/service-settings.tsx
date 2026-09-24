import { useRouter } from '@tanstack/react-router'
import { SettingsIcon, XIcon } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react'
import { cn } from '../lib/cn'
import { hostnameError } from '../lib/hostname'
import {
  type ModuleSwitch,
  type ModuleWeb,
  STRUCTURAL_WHY,
  webLabelAfter,
  webPublicAfter,
} from '../lib/module-switch'
import { useShown } from '../lib/shown'
import { useSite } from '../lib/site-context'
import { fetchModuleSwitchFn, setModuleEnabledFn, setModuleWebFn } from '../server/modules'
import { GHOST_BTN } from './apps/shared'
import { FOOT, MONO, NOTE } from './tokens'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Picker } from './ui/picker'
import { Switch } from './ui/switch'
import { Chip } from './viz'

// The cog on a service: one dialog that holds everything the operator may
// move about the stack a page fronts — on or off, where each of its
// hostnames answers, and whether the tunnel carries them.
//
// Every control here is a site edit (modules.enabled and modules.web in
// site.json) and lands on the next Apply, so each does two things and never a
// third: it writes the draft, and it says what the draft would do. Nothing
// here rebuilds. The Apply bar at the top of Apps is where the change lands,
// as for every other site change, and the dialog says so at its foot. The
// same dialog opens from a tab's head and from Settings › Modules.

const OVERLAY = 'fixed inset-0 z-[70] bg-[color-mix(in_srgb,var(--overlay)_45%,transparent)]'
const PANEL = cn(
  'fixed top-1/2 left-1/2 z-[71] w-[min(92vw,36rem)] max-h-[88vh] overflow-y-auto',
  '-translate-x-1/2 -translate-y-1/2 rounded-[12px] border border-(--border) bg-(--panel) p-[1.1rem]',
  'text-foreground shadow-[0_24px_60px_-20px_rgb(0_0_0/0.5)] outline-none',
)
const INPUT = cn(
  'h-auto w-[11rem] max-w-full rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.35rem]',
  'font-mono md:text-[0.8rem] dark:bg-(--panel-2)',
)
const AFFIX = 'font-mono text-[0.8rem] text-(--dim)'

const EXPOSURE = [
  { value: 'lan', label: 'LAN only' },
  { value: 'public', label: 'Public, through the tunnel' },
]

/** The cog. Draws nothing for a tab that fronts no stack. */
export function ServiceSettingsButton({
  ids,
  size = 'sm',
}: {
  ids: readonly string[]
  size?: 'sm' | 'xs'
}) {
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  return (
    <ServiceSettingsDialog ids={ids} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={GHOST_BTN}
          aria-label={`Settings for ${ids.join(', ')}`}
          title={`Settings for ${ids.join(', ')}`}
        >
          <SettingsIcon className={size === 'xs' ? 'size-[0.95rem]' : 'size-[1.05rem]'} />
        </Button>
      </Dialog.Trigger>
    </ServiceSettingsDialog>
  )
}

/**
 * The dialog itself, fetched when it opens: the switches are a footer's
 * worth of data, and a page must not wait on them.
 */
export function ServiceSettingsDialog({
  ids,
  open,
  onOpenChange,
  children,
}: {
  ids: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The trigger, when the dialog is opened by one. */
  children?: ReactNode
}) {
  const key = ids.join(',')
  const [rows, setRows] = useState<ModuleSwitch[] | null>(null)
  const [tick, setTick] = useState(0)
  const moved = useCallback(() => setTick((t) => t + 1), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the refetch trigger, on purpose
  useEffect(() => {
    if (!open || key === '') return
    let live = true
    void fetchModuleSwitchFn({ data: { ids: key.split(',') } }).then((r) => {
      if (live) setRows(r)
    })
    return () => {
      live = false
    }
  }, [open, key, tick])
  const titleId = useId()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={PANEL} aria-labelledby={titleId}>
          <div className="mb-[0.8rem] flex items-start gap-3">
            <div className="min-w-0 flex-auto">
              <Dialog.Title id={titleId} className="m-0 text-[1rem] font-semibold">
                {ids.length === 1 ? 'This service' : 'These services'}
              </Dialog.Title>
              <Dialog.Description className={`${NOTE} m-0 mt-[0.15rem]`}>
                On or off, where it answers, and who can reach it. Every change lands on the next
                Apply.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={GHOST_BTN}
                aria-label="Close"
              >
                <XIcon className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          {rows === null ? (
            <p className={NOTE}>Reading the box…</p>
          ) : rows.length === 0 ? (
            <p className={NOTE}>This box declares none of {ids.join(', ')}.</p>
          ) : (
            <div className="flex flex-col gap-[1rem]">
              {rows.map((m) => (
                <ServiceCard key={m.id} m={m} onMoved={moved} />
              ))}
            </div>
          )}
          <p className={`${FOOT} mt-[1rem]`}>
            Nothing here rebuilds. What you move is written to site.json on the next Apply, from the
            bar at the top of Apps; until then the box runs as it does now.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

type Draft = 'idle' | 'asking' | 'saving'

function ServiceCard({ m, onMoved }: { m: ModuleSwitch; onMoved: () => void }) {
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
    <section className="rounded-[10px] border border-(--border-soft) bg-(--panel-2) p-[0.8rem]">
      <div className="flex flex-wrap items-center gap-[0.5rem]">
        <span className={`${MONO} text-[0.9rem]`}>{m.id}</span>
        <Chip tone={desired ? 'ok' : 'muted'}>{desired ? 'on' : 'off'}</Chip>
        {pending && <Chip tone="warn">{m.desired ? 'on after Apply' : 'off after Apply'}</Chip>}
        <span className="ml-auto flex items-center gap-[0.5rem]">
          {m.structural ? (
            <span
              className="text-[0.75rem] text-muted-foreground"
              title={STRUCTURAL_WHY[m.id] ?? 'a running box cannot do without it'}
            >
              always on
            </span>
          ) : (
            <Switch
              aria-label={`${m.id} on`}
              checked={desired}
              disabled={draft === 'saving'}
              onCheckedChange={(v) => (v ? void move(true) : setDraft('asking'))}
            />
          )}
        </span>
      </div>
      <p className={`${FOOT} mt-[0.3rem]`}>
        {m.containers.length} {m.containers.length === 1 ? 'container' : 'containers'}
        {m.structural && ` · ${STRUCTURAL_WHY[m.id] ?? 'a running box cannot do without it'}`}
      </p>
      {draft === 'asking' && (
        <div className="mt-[0.6rem] rounded-md border border-(--border-soft) bg-(--panel) p-[0.7rem]">
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
            . Its tab stays in the rail, greyed. The data stays where it is under the state root,
            and the switch is one Apply away from on again.
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
      {m.web.length > 0 && (
        <div className="mt-[0.7rem] flex flex-col gap-[0.6rem] border-(--border-soft) border-t pt-[0.6rem]">
          {m.web.map((w) => (
            <WebRow key={w.name} id={m.id} w={w} onMoved={onMoved} />
          ))}
        </div>
      )}
      {refused !== null && <p className={`${FOOT} text-(--tone-bad)`}>{refused}</p>}
    </section>
  )
}

/**
 * One hostname: its label under the domain, and its exposure. Each saves on
 * its own — the label on blur or Enter, the exposure on choice — and shows
 * what it is changing FROM while the change waits for an Apply.
 */
function WebRow({ id, w, onMoved }: { id: string; w: ModuleWeb; onMoved: () => void }) {
  const router = useRouter()
  const site = useSite()
  const [text, setText] = useState(webLabelAfter(w))
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [exposure, showExposure] = useShown(
    webPublicAfter(w) ? 'public' : 'lan',
    saving,
    refused !== null,
  )
  const labelPending = webLabelAfter(w) !== w.label
  const publicPending = webPublicAfter(w) !== w.public
  const inputId = useId()

  // Reset the box when the row's data moves under it (a refetch after a save).
  const after = webLabelAfter(w)
  // biome-ignore lint/correctness/useExhaustiveDependencies: the input follows the saved value, not its own edits
  useEffect(() => setText(after), [after])

  const local =
    text.trim() === '' || text.trim().toLowerCase() === after
      ? null
      : hostnameError(site, `${text.trim().toLowerCase()}.${site.baseDomain}`, [])

  const write = async (patch: { label?: string | null; public?: boolean | null }) => {
    setSaving(true)
    setRefused(null)
    const r = await setModuleWebFn({ data: { id, name: w.name, ...patch } })
    if (!r.ok) setRefused(r.reason)
    setSaving(false)
    onMoved()
    await router.invalidate()
  }

  const saveLabel = () => {
    const v = text.trim().toLowerCase()
    if (v === after || local !== null) return
    void write({ label: v === '' ? null : v })
  }

  return (
    <div className="text-[0.8rem]">
      <div className="flex flex-wrap items-center gap-x-[0.5rem] gap-y-[0.35rem]">
        <label htmlFor={inputId} className="min-w-[4.5rem] text-muted-foreground">
          {w.name === id ? 'Address' : w.name}
        </label>
        <span className="inline-flex items-center gap-[0.3rem]">
          <Input
            id={inputId}
            className={INPUT}
            value={text}
            disabled={saving}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setText(e.target.value)}
            onBlur={saveLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
          <span className={AFFIX}>.{site.baseDomain}</span>
        </span>
        <Picker
          aria-label={`${w.name} exposure`}
          className="w-[15rem]"
          value={exposure}
          options={EXPOSURE}
          disabled={saving}
          busy={saving}
          failed={refused !== null}
          onChange={(v) => {
            showExposure(v)
            void write({ public: v === 'public' })
          }}
        />
        {labelPending && <Chip tone="warn">was {w.label}</Chip>}
        {publicPending && <Chip tone="warn">{w.public ? 'was public' : 'was LAN only'}</Chip>}
        {(w.desired.label !== null || w.desired.public !== null) && (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-[0.72rem] text-(--text-muted) underline underline-offset-2 hover:text-foreground"
            disabled={saving}
            onClick={() => void write({ label: null, public: null })}
          >
            as the host says
          </button>
        )}
      </div>
      {w.aliases.length > 0 && <p className={`${FOOT}`}>also answers at {w.aliases.join(', ')}</p>}
      {local !== null && <p className={`${FOOT} text-(--tone-bad)`}>{local}</p>}
      {refused !== null && <p className={`${FOOT} text-(--tone-bad)`}>{refused}</p>}
    </div>
  )
}
