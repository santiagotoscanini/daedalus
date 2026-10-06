import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

/*
 * shadcn's Button with this app's button vocabulary in place of the stock
 * variants, so every button on the page is this component and nothing
 * hand-rolls the same four looks beside it.
 *
 * The looks are the ones the dashboard already had. The Geist signature in
 * particular: the primary action is the FOREGROUND colour, not the brand —
 * the accent identifies the app, and the one thing you came to press is the
 * one white thing on a dark page (the one dark thing on a light one). A
 * destructive action is outlined in the danger colour rather than filled;
 * red fill on a control plane reads as "already broken", not "careful".
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[9px] border border-transparent text-[0.82rem] font-medium tracking-[-0.005em] no-underline outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:not-disabled:scale-[0.98] hover:no-underline disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-dim aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-foreground bg-foreground text-background [font-weight:560] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--background)_22%,transparent),0_1px_2px_color-mix(in_oklch,var(--overlay)_22%,transparent),0_4px_14px_-6px_color-mix(in_oklch,var(--foreground)_35%,transparent)] [&:hover:not(:disabled)]:border-foreground/88 [&:hover:not(:disabled)]:bg-foreground/88',
        secondary:
          'bg-foreground/[0.07] text-foreground [&:hover:not(:disabled)]:bg-foreground/[0.11]',
        outline:
          'border-hairline bg-surface text-foreground shadow-[inset_0_1px_0_var(--hairline-hi)] [&:hover:not(:disabled)]:border-foreground/15 [&:hover:not(:disabled)]:bg-surface-hover',
        ghost:
          'bg-transparent text-subdued [&:hover:not(:disabled)]:bg-foreground/[0.06] [&:hover:not(:disabled)]:text-foreground',
        destructive:
          'border-[color-mix(in_srgb,var(--danger)_50%,var(--border))] bg-transparent text-danger [&:hover:not(:disabled)]:bg-danger/10',
        link: 'border-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7.5 gap-1.5 rounded-[8px] px-3 text-[0.78rem] has-[>svg]:px-2.5',
        default: 'h-8.5 px-3.5 py-1.5 has-[>svg]:px-3',
        lg: 'h-10 rounded-[10px] px-5 has-[>svg]:px-4',
        icon: 'size-8.5',
        'icon-sm': 'size-7 rounded-[8px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
