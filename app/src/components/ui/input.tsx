import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // `text-base` below the `md` breakpoint, not `text-sm`: iOS Safari
        // zooms the viewport when focusing a field whose text is under 16px.
        // The house field: filled with the interactive surface in both
        // modes, so a form reads the same on every page. The three densities
        // a caller picks from are INPUT_* in components/tokens.ts.
        'flex h-9 w-full min-w-0 rounded-[8px] border border-input bg-(--panel-2) px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] md:text-sm',
        'file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
