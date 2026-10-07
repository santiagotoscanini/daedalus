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
import { errorText } from '../lib/redact'
import { useShown } from '../lib/shown'
import { useSite } from '../lib/site-context'
import { fetchModuleSwitchFn, setModuleEnabledFn, setModuleWebFn } from '../server/modules'
import { GHOST_BTN } from './apps/shared'
import { CAPTION, FOOT, FOOT_BASE, INPUT_MONO, MONO, NOTE } from './tokens'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Picker } from './ui/picker'
import { Switch } from './ui/switch'
import { useAction } from './use-action'
import { Chip } from './viz'

// The cog on a service: one dialog that holds everything the operator may
// move about the stack a page fronts — on or off, where each of its
// hostnames answers, and whether the tunnel carries them.
//
// Every control here is a site edit (modules.enabled and modules.web in
// site.json) and lands on the next Apply, so each does two things and never a
// third: it writes the draft, and it says what the draft would do. Nothing
// here rebuilds. The Apply bar (pending-apply-bar.tsx, on every page) is where
// the change lands, as for every other site change. The same dialog opens
// from a module page's tab row, the module boards, and Settings › Modules.

const OVERLAY =
  'fixed inset-0 z-[70] bg-[color-mix(in_oklch,var(--overlay)_45%,transparent)] backdrop-blur-[2px]'
const PANEL = cn(
  'fixed top-1/2 left-1/2 z-[71] w-[min(92vw,36rem)] max-h-[88vh] overflow-y-auto',
  '-translate-x-1/2 -translate-y-1/2 rounded-2xl border border-hairline bg-popover p-5',
  'text-popover-foreground shadow-(--float-shadow) outline-none',
)
const INPUT = cn(INPUT_MONO, 'w-[11rem] max-w-full')
const AFFIX = 'font-mono text-[0.8rem] text-muted-foreground'

const EXPOSURE = [
  { value: 'lan', label: 'LAN only' },
  { value: 'public', label: 'Public, through the tunnel' },
]

/** The cog. Draws nothing for a tab that fronts no stack. */
export function ServiceSettingsButton({
  ids,
  size = 'sm',
  label,
}: {
  ids: readonly string[]
  size?: 'sm' | 'xs'
  /** Draw a labelled outline button instead of the bare cog — for an empty
      state, where the switch is the one thing to do. */
  label?: string
}) {
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  return (
    <ServiceSettingsDialog ids={ids} open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {label !== undefined ? (
          <Button type="button" variant="outline" size="sm">
            <SettingsIcon />
            {label}
          </Button>
        ) : (
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
        )}
      </Dialog.Trigger>
    </ServiceSettingsDialog>
  )
}

/**
 * The dialog itself, fetched when it opens: the switches are a footer's
 * worth of data, and a page must not wait on them.
 */
function ServiceSettingsDialog({
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
  const [failed, setFailed] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const moved = useCallback(() => setTick((t) => t + 1), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the refetch trigger, on purpose
  useEffect(() => {
    if (!open || key === '') return
    let live = true
    fetchModuleSwitchFn({ data: { ids: key.split(',') } }).then(
      (r) => {
        if (!live) return
        setRows(r)
        setFailed(null)
      },
      (e: unknown) => {
        if (live) setFailed(errorText(e))
      },
    )
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
          <div className="mb-4 flex items-start gap-3">
            <div className="min-w-0 flex-auto">
              <Dialog.Title
                id={titleId}
                className="m-0 text-[1rem] tracking-[-0.01em] [font-weight:600]"
              >
                {ids.length === 1 ? 'This service' : 'These services'}
              </Dialog.Title>
              <Dialog.Description className={cn(NOTE, 'm-0 mt-0.5')}>
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
          {failed !== null ? (
            <p className="m-0 text-[0.75rem] text-danger">{failed}</p>
          ) : rows === null ? (
            <p className={NOTE}>Reading the box…</p>
          ) : rows.length === 0 ? (
            <p className={NOTE}>This box declares none of {ids.join(', ')}.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((m) => (
                <ServiceCard key={m.id} m={m} onMoved={moved} />
              ))}
            </div>
          )}
          <p className={cn(FOOT, 'mt-4')}>
            Nothing here rebuilds. What you move is written to site.json on the next Apply, from the
            bar at the top of Apps; until then the box runs as it does now.
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ServiceCard({ m, onMoved }: { m: ModuleSwitch; onMoved: () => void }) {
  const [asking, setAsking] = useState(false)
  const { run, busy: saving, error: refused } = useAction()
  const [desired, show] = useShown(m.desired, saving, refused !== null)
  const pending = m.desired !== m.running

  const move = (enabled: boolean) => {
    setAsking(false)
    show(enabled)
    run(async () => {
      const r = await setModuleEnabledFn({ data: { id: m.id, enabled } })
      onMoved()
      return r
    })
  }

  return (
    <section className="rounded-xl border border-hairline bg-surface px-4 py-3.5 shadow-[inset_0_1px_0_var(--hairline-hi)]">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(MONO, 'text-[0.875rem]')}>{m.id}</span>
        <Chip tone={desired ? 'ok' : 'muted'}>{desired ? 'on' : 'off'}</Chip>
        {pending && <Chip tone="warn">{m.desired ? 'on after Apply' : 'off after Apply'}</Chip>}
        <span className="ml-auto flex items-center gap-2">
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
              disabled={saving}
              onCheckedChange={(v) => (v ? move(true) : setAsking(true))}
            />
          )}
        </span>
      </div>
      <p className={cn(CAPTION, 'mt-1')}>
        {m.containers.length} {m.containers.length === 1 ? 'container' : 'containers'}
        {m.structural && ` · ${STRUCTURAL_WHY[m.id] ?? 'a running box cannot do without it'}`}
      </p>
      {asking && (
        <div className="mt-3 rounded-lg border border-hairline bg-foreground/[0.03] p-3">
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
          <div className="mt-2.5 flex gap-2">
            <Button type="button" size="sm" onClick={() => move(false)}>
              Switch {m.id} off
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={GHOST_BTN}
              onClick={() => setAsking(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
      {m.web.length > 0 && (
        <div className="mt-3 flex flex-col gap-2.5 border-hairline border-t pt-3">
          {m.web.map((w) => (
            <WebRow key={w.name} id={m.id} w={w} onMoved={onMoved} />
          ))}
        </div>
      )}
      {refused !== null && <p className={cn(FOOT_BASE, 'text-danger')}>{refused}</p>}
    </section>
  )
}

/**
 * One hostname: its label under the domain, and its exposure. Each saves on
 * its own — the label on blur or Enter, the exposure on choice — and shows
 * what it is changing FROM while the change waits for an Apply.
 */
function WebRow({ id, w, onMoved }: { id: string; w: ModuleWeb; onMoved: () => void }) {
  const site = useSite()
  const [text, setText] = useState(webLabelAfter(w))
  const { run, busy: saving, error: refused } = useAction()
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

  const write = (patch: { label?: string | null; public?: boolean | null }) => {
    run(async () => {
      const r = await setModuleWebFn({ data: { id, name: w.name, ...patch } })
      onMoved()
      return r
    })
  }

  const saveLabel = () => {
    const v = text.trim().toLowerCase()
    if (v === after || local !== null) return
    write({ label: v === '' ? null : v })
  }

  return (
    <div className="text-[0.8rem]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <label htmlFor={inputId} className="min-w-[4.5rem] text-muted-foreground">
          {w.name === id ? 'Address' : w.name}
        </label>
        <span className="inline-flex items-center gap-1">
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
            write({ public: v === 'public' })
          }}
        />
        {labelPending && <Chip tone="warn">was {w.label}</Chip>}
        {publicPending && <Chip tone="warn">{w.public ? 'was public' : 'was LAN only'}</Chip>}
        {(w.desired.label !== null || w.desired.public !== null) && (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-[0.72rem] font-normal text-subdued underline underline-offset-2 hover:text-foreground"
            disabled={saving}
            onClick={() => write({ label: null, public: null })}
          >
            as the host says
          </Button>
        )}
      </div>
      {w.aliases.length > 0 && <p className={CAPTION}>also answers at {w.aliases.join(', ')}</p>}
      {local !== null && <p className={cn(FOOT_BASE, 'text-danger')}>{local}</p>}
      {refused !== null && <p className={cn(FOOT_BASE, 'text-danger')}>{refused}</p>}
    </div>
  )
}
