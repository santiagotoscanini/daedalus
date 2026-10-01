import { Dialog } from 'radix-ui'
import { cn } from '../../lib/cn'
import { NavIcon } from '../nav-icon'
import { RailBody, type RailBodyProps } from './rail'
import { ICON_BUTTON } from './styles'
import type { Drawer } from './use-rail'

// Phone only: the rail as a drawer over the page, below the 52rem breakpoint.
// A Radix dialog, so the focus trap, Escape, the scroll lock behind it, the
// dimmed layer that closes it on a tap and focus back on the ☰ button are
// the dialog's. It mounts only while open, and slides in and out on
// tw-animate-css's enter/exit utilities.

const OVERLAY = cn(
  'fixed inset-0 z-50 bg-overlay/55 rail:hidden',
  'data-[state=open]:animate-in data-[state=open]:fade-in-0',
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
)

const PANEL = cn(
  'fixed inset-y-0 left-0 z-[60] flex h-[100dvh] w-[min(17.5rem,82vw)] flex-col gap-[1.1rem]',
  'overflow-y-auto border-r border-r-border bg-background outline-none rail:hidden',
  'px-[0.7rem] pt-3 pb-[1.4rem] pl-[max(0.7rem,env(safe-area-inset-left))]',
  'duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)]',
  'data-[state=open]:animate-in data-[state=open]:slide-in-from-left',
  'data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left',
)

export function PhoneDrawer({
  drawer,
  ...body
}: Omit<RailBodyProps, 'close'> & { drawer: Drawer }) {
  return (
    <Dialog.Root open={drawer.open} onOpenChange={drawer.setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content className={PANEL} aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <RailBody
            {...body}
            close={
              <Dialog.Close asChild>
                <button type="button" className={ICON_BUTTON} aria-label="Close navigation">
                  <NavIcon name="close" size={18} />
                </button>
              </Dialog.Close>
            }
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
