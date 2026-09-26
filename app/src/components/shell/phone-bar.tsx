import { Link } from '@tanstack/react-router'
import { cn } from '../../lib/cn'
import { NavIcon } from '../nav-icon'
import { BRAND, ICON_BUTTON } from './styles'
import type { Drawer } from './use-rail'

/**
 * Phone only: the bar across the top. The rail is off-canvas there, so the
 * brand and the way back into it need somewhere that is always on screen.
 * Translucent rather than solid: the page scrolling under it is the cue that
 * this bar is fixed and the content is not.
 */
export function PhoneBar({ drawer }: { drawer: Drawer }) {
  return (
    <header
      className={cn(
        'hidden max-rail:flex max-rail:items-center max-rail:gap-1.5',
        'sticky top-0 z-40 border-b border-b-(--border-soft) px-3 py-[0.45rem]',
        'pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]',
        'bg-background/88 backdrop-blur-[10px]',
      )}
    >
      <button
        ref={drawer.openButton}
        type="button"
        className={ICON_BUTTON}
        aria-label="Open navigation"
        aria-expanded={drawer.open}
        aria-controls="nav"
        onClick={drawer.show}
      >
        <NavIcon name="menu" size={20} />
      </button>
      <Link to="/apps" className={cn(BRAND, 'flex-none px-1.5')}>
        <img src="/icon.svg" alt="" width={26} height={26} className="flex-none" />
        <span>daedalus</span>
      </Link>
    </header>
  )
}

/**
 * Phone only: the dimmed layer behind the open drawer; a tap closes it.
 * Not a button — it duplicates the close control for a pointer, and a screen
 * reader that already has one does not need a second. Kept in the DOM and
 * faded by `data-open` so the transition can play both ways.
 */
export function Scrim({ drawer }: { drawer: Drawer }) {
  return (
    <div
      className={cn(
        'hidden max-rail:block max-rail:fixed max-rail:inset-0 max-rail:z-50',
        'bg-overlay/55 opacity-0 invisible transition-[opacity,visibility]',
        'duration-200 delay-[0s,200ms]',
        'data-[open=true]:visible data-[open=true]:opacity-100 data-[open=true]:delay-0',
      )}
      data-open={drawer.open ? 'true' : 'false'}
      onClick={() => {
        drawer.hide()
      }}
      aria-hidden="true"
    />
  )
}
