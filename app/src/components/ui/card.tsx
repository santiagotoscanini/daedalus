import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'
import { GLASS } from '../viz/board'

function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        GLASS,
        'group/card relative flex flex-col gap-4 py-5 text-card-foreground',
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        '@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1 px-5 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-5',
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        'text-[0.95rem] leading-tight tracking-[-0.015em] [font-weight:580]',
        className,
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('max-w-[72ch] text-[0.82rem] leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-5', className)} {...props} />
}

export { Card, CardContent, CardDescription, CardHeader, CardTitle }
