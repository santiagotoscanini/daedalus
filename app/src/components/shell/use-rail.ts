import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

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

export type Drawer = {
  open: boolean
  show: () => void
  /** Close; `restoreFocus` puts focus back on the button that opened it. */
  hide: (restoreFocus?: boolean) => void
  openButton: RefObject<HTMLButtonElement | null>
  closeButton: RefObject<HTMLButtonElement | null>
}

/**
 * The phone drawer: the rail, off-canvas below the 52rem breakpoint.
 *
 * Everything a dialog needs, by hand:
 * - closes on every navigation (`path` is the trigger) — a menu you must
 *   dismiss yourself after tapping a link is one tap too many;
 * - closes when the window grows past the breakpoint — a drawer left open
 *   there would keep the body's scroll lock under a desktop layout, and the
 *   page would stop scrolling (rotating a tablet is enough);
 * - while open: focus moves to the close button, Escape closes and returns
 *   focus to the opener, and the page behind does not scroll.
 */
export function useDrawer(path: string): Drawer {
  const [open, setOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

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

  useEffect(() => {
    if (!open) return
    // Not now, and not "next frame" either: the drawer turns visible through a
    // `visibility` transition (rail.tsx), which still reads `hidden` in the
    // frame it starts, and a browser silently refuses focus to a hidden
    // element — it would stay on the ☰ button. So try each frame until focus
    // lands, giving up after a few (the transition is 220ms).
    let frame = 0
    let tries = 0
    const focusClose = () => {
      const button = closeButton.current
      button?.focus()
      if (button && document.activeElement !== button && ++tries < 30) {
        frame = requestAnimationFrame(focusClose)
      }
    }
    frame = requestAnimationFrame(focusClose)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        openButton.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    // On a phone a swipe meant for the menu otherwise moves the list underneath it.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open])

  const show = useCallback(() => {
    setOpen(true)
  }, [])
  const hide = useCallback((restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) openButton.current?.focus()
  }, [])

  return { open, show, hide, openButton, closeButton }
}
