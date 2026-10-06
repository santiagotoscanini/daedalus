import { Link } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
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
export function PhoneBar({ drawer, onOpenPalette }: { drawer: Drawer; onOpenPalette: () => void }) {
  return (
    <header
      className={cn(
        'hidden max-rail:flex max-rail:items-center max-rail:gap-1.5',
        'sticky top-0 z-40 border-b border-b-hairline px-3 py-[0.45rem]',
        'pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]',
        'bg-chrome backdrop-blur-2xl backdrop-saturate-150',
      )}
    >
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label="Open navigation"
        aria-expanded={drawer.open}
        onClick={() => {
          drawer.setOpen(true)
        }}
      >
        <NavIcon name="menu" size={20} />
      </button>
      <Link to="/apps" className={cn(BRAND, 'flex-none px-1.5')}>
        <img src="/icon.svg" alt="" width={26} height={26} className="flex-none" />
        <span>Daedalus</span>
      </Link>
      <button
        type="button"
        className={cn(ICON_BUTTON, 'ml-auto')}
        aria-label="Search and jump"
        onClick={onOpenPalette}
      >
        <SearchIcon className="size-[19px]" strokeWidth={1.75} />
      </button>
    </header>
  )
}
