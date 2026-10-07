import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // See input.tsx: 16px minimum below `md` keeps iOS Safari from zooming.
        'field-sizing-content flex min-h-16 w-full rounded-[9px] border border-hairline bg-card dark:bg-foreground/[0.04] px-3 py-2 text-base outline-none transition-[color,box-shadow] md:text-[0.8125rem]',
        'placeholder:text-muted-foreground',
        'focus-visible:border-primary/55 focus-visible:ring-[3px] focus-visible:ring-primary/15',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        'dark:bg-input/30',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
