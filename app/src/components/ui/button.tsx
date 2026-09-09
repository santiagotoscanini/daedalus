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
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[7px] border border-transparent text-[0.84rem] font-medium no-underline outline-none transition-colors duration-150 hover:no-underline disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-dim) aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'border-foreground bg-foreground text-background [font-weight:550] [&:hover:not(:disabled)]:border-foreground/85 [&:hover:not(:disabled)]:bg-foreground/85',
        secondary:
          'bg-secondary text-secondary-foreground [&:hover:not(:disabled)]:bg-secondary/80',
        outline:
          'border-(--border) bg-transparent text-foreground [&:hover:not(:disabled)]:bg-(--panel-2)',
        ghost:
          'bg-transparent text-(--text-muted) [&:hover:not(:disabled)]:bg-(--panel-2) [&:hover:not(:disabled)]:text-foreground',
        destructive:
          'border-[color-mix(in_srgb,var(--danger)_50%,var(--border))] bg-transparent text-danger [&:hover:not(:disabled)]:bg-danger/12',
        link: 'border-0 text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
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
