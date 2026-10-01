import { useCallback, useEffect, useState } from 'react'

/**
 * The desktop rail's collapsed state.
 *
 * The DOM attribute `<html data-nav>` is authoritative — the boot script set
 * it before React existed (boot.ts), and the stylesheet reads it. This state
 * only mirrors it, so the toggle's label and `aria-pressed` agree with the
 * page. `toggle` writes the attribute and remembers the choice per browser.
 */
export function useRailCollapse(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    setCollapsed(document.documentElement.dataset.nav === 'collapsed')
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((was) => {
      const next = !was
      document.documentElement.dataset.nav = next ? 'collapsed' : 'open'
      try {
        localStorage.setItem('daedalus:nav', next ? 'collapsed' : 'open')
      } catch {
        // Private mode, or storage full. The rail still collapses; it just
        // will not remember, which is not worth failing a click over.
      }
      return next
    })
  }, [])

  return { collapsed, toggle }
}

export type Drawer = { open: boolean; setOpen: (open: boolean) => void }

/**
 * The phone drawer's open state (phone-drawer.tsx draws it, as a Radix
 * dialog: the focus trap, Escape, the scroll lock and focus back on the
 * opener are the dialog's). What is left for here is when it closes on its
 * own:
 * - on every navigation (`path` is the trigger) — a menu you must dismiss
 *   yourself after tapping a link is one tap too many;
 * - when the window grows past the breakpoint — a drawer left open there
 *   would keep the body's scroll lock under a desktop layout, and the page
 *   would stop scrolling (rotating a tablet is enough).
 */
export function useDrawer(path: string): Drawer {
  const [open, setOpen] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `path` is not read in the body — it IS the trigger; the effect exists to run on navigation.
  useEffect(() => {
    setOpen(false)
  }, [path])

  useEffect(() => {
    const wide = window.matchMedia('(width > 52rem)')
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setOpen(false)
    }
    wide.addEventListener('change', onChange)
    return () => {
      wide.removeEventListener('change', onChange)
    }
  }, [])

  return { open, setOpen }
}
