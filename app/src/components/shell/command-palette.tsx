import { useRouter } from '@tanstack/react-router'
import {
  CornerDownLeftIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import type { ModuleManifest } from '../../lib/modules/manifest'
import type { ThemeChoice } from '../../lib/theme'
import { APP_TABS } from '../../routes/apps.$name'
import { saveTheme } from '../../server/settings'
import { fetchPaletteFn } from '../../server/shell'
import { NavIcon, type NavIconName } from '../nav-icon'
import { useAction } from '../use-action'
import { buildItems, type PaletteItem, rank } from './palette-items'

// ⌘K: one field that reaches every page, tab, app and machine, and the few
// verbs the chrome already offers. A Radix dialog, so focus, Escape and the
// scroll lock are the dialog's. The list is built from what the shell holds
// plus one small read (apps and machines), made the first time it opens.

const LUCIDE: Record<string, ReactNode> = {
  search: <SearchIcon />,
  sun: <SunIcon />,
  moon: <MoonIcon />,
  monitor: <MonitorIcon />,
  sidebar: <PanelLeftIcon />,
  logout: <LogOutIcon />,
  plus: <PlusIcon />,
}

/** Opens on ⌘K / Ctrl+K anywhere, and on `/` when no field has focus. */
export function usePaletteHotkey(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        return
      }
      const t = e.target as HTMLElement | null
      const typing =
        t !== null && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen(() => true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpen])
}

export function CommandPalette({
  open,
  onOpenChange,
  modules,
  theme,
  onToggleRail,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  modules: ModuleManifest[]
  theme: ThemeChoice
  onToggleRail: () => void
}) {
  const router = useRouter()
  const { run } = useAction()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPaletteFn>> | null>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || data !== null) return
    fetchPaletteFn()
      .then(setData)
      .catch(() => setData({ apps: [], machines: [] }))
  }, [open, data])

  const items = useMemo(() => buildItems(modules, APP_TABS, data), [modules, data])
  const shown = useMemo(() => rank(items, query), [items, query])
  // Grouped in the order each group's best entry ranks.
  const groups = useMemo(() => {
    const out: { name: string; items: { item: PaletteItem; index: number }[] }[] = []
    shown.forEach((item, index) => {
      let g = out.find((x) => x.name === item.group)
      if (g === undefined) {
        g = { name: item.group, items: [] }
        out.push(g)
      }
      g.items.push({ item, index })
    })
    return out
  }, [shown])
  // The flat order the arrow keys walk: the groups as drawn.
  const order = useMemo(() => groups.flatMap((g) => g.items.map((x) => x.index)), [groups])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])
  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${String(order[active] ?? -1)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, order])

  const choose = (item: PaletteItem) => {
    onOpenChange(false)
    const a = item.action
    if (a.kind === 'go') void router.navigate(a.to)
    else if (a.kind === 'href') window.location.assign(a.href)
    else if (a.verb === 'toggle-rail') onToggleRail()
    else {
      const scheme =
        a.verb === 'theme-dark' ? 'dark' : a.verb === 'theme-light' ? 'light' : 'system'
      run(() => saveTheme({ data: { presetId: theme.presetId, scheme } }))
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      setActive((i) => Math.min(order.length - 1, i + 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = shown[order[active] ?? -1]
      if (item !== undefined) choose(item)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={PANEL} aria-describedby={undefined} onKeyDown={onKeyDown}>
          <Dialog.Title className="sr-only">Go to</Dialog.Title>
          <div className="flex items-center gap-3 border-hairline border-b px-4">
            <SearchIcon
              className="size-[18px] flex-none text-muted-foreground"
              strokeWidth={1.75}
            />
            <input
              // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder="Search pages, apps, machines, actions…"
              className="h-14 min-w-0 flex-1 border-0 bg-transparent text-[0.98rem] text-foreground tracking-[-0.01em] outline-none placeholder:text-muted-foreground/70"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={
                order[active] === undefined ? undefined : `palette-${String(order[active])}`
              }
            />
            <kbd className={KBD}>esc</kbd>
          </div>
          <div
            ref={list}
            id="palette-list"
            role="listbox"
            className="max-h-[min(26rem,58vh)] overflow-y-auto overscroll-contain p-2"
          >
            {shown.length === 0 ? (
              <p className="m-0 px-3 py-10 text-center text-[0.85rem] text-muted-foreground">
                Nothing matches “{query}”.
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.name} className="mb-1 last:mb-0">
                  <div className="px-3 pt-2 pb-1 text-[0.7rem] text-muted-foreground [font-weight:550]">
                    {g.name}
                  </div>
                  {g.items.map(({ item, index }) => {
                    const on = order[active] === index
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: the keys belong to the combobox, which points here with aria-activedescendant
                      <div
                        key={item.id}
                        id={`palette-${String(index)}`}
                        data-index={index}
                        role="option"
                        aria-selected={on}
                        tabIndex={-1}
                        onMouseMove={() => setActive(order.indexOf(index))}
                        onClick={() => choose(item)}
                        className={cn(
                          'flex h-10 cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[0.86rem] text-subdued',
                          on && 'bg-foreground/[0.07] text-foreground',
                        )}
                      >
                        <span className={cn(ICON_TILE, on && 'border-primary/40 text-primary')}>
                          {item.icon in LUCIDE ? (
                            LUCIDE[item.icon]
                          ) : (
                            <NavIcon name={item.icon as NavIconName} size={15} />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint !== undefined && (
                          <span className="flex-none text-[0.74rem] text-muted-foreground">
                            {item.hint}
                          </span>
                        )}
                        {on && (
                          <CornerDownLeftIcon className="size-3.5 flex-none text-muted-foreground" />
                        )}
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-4 border-hairline border-t px-4 py-2.5 text-[0.72rem] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <kbd className={KBD}>↑</kbd>
              <kbd className={KBD}>↓</kbd> to move
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className={KBD}>↵</kbd> to open
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <kbd className={KBD}>⌘K</kbd> anywhere
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The rail's way in: reads as a search field, opens the palette. */
export function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-label="Search"
      aria-label="Search and jump (⌘K)"
      className={cn(
        'mb-1 flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-[7px] border border-hairline bg-foreground/[0.03] px-2',
        'text-[0.8125rem] text-muted-foreground transition-[background-color,border-color,color] duration-150',
        'hover:border-foreground/15 hover:bg-foreground/[0.06] hover:text-foreground',
        'focus-visible:outline-2 focus-visible:outline-primary-dim focus-visible:outline-offset-2',
        'nav-collapsed:justify-center nav-collapsed:px-0',
      )}
    >
      <SearchIcon className="size-4 flex-none" strokeWidth={1.75} />
      <span className="flex-1 text-left nav-collapsed:hidden">Search</span>
      <kbd className={cn(KBD, 'nav-collapsed:hidden')}>⌘K</kbd>
    </button>
  )
}

const KBD =
  'inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-hairline bg-foreground/[0.05] px-1.5 font-sans text-[0.68rem] text-muted-foreground [font-weight:500]'

const ICON_TILE =
  'inline-flex size-7 flex-none items-center justify-center rounded-[8px] border border-hairline bg-foreground/[0.04] text-muted-foreground [&>svg]:size-[15px] [&>svg]:opacity-100'

const OVERLAY = cn(
  'fixed inset-0 z-[90] bg-overlay/45 backdrop-blur-[3px]',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
)

const PANEL = cn(
  'fixed top-[13vh] left-1/2 z-[95] w-[min(40rem,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden outline-none',
  'rounded-[18px] border border-hairline bg-popover/80 backdrop-blur-2xl backdrop-saturate-150',
  'shadow-[inset_0_1px_0_var(--hairline-hi),var(--float-shadow),0_0_80px_-30px_var(--glow-a)]',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=open]:slide-in-from-top-2',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]',
  'duration-150',
)
