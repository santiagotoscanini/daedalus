/* The form row: label, control, hint, error, in one arrangement.
   ─────────────────────────────────────────────────────────────────────────
   Not a stock shadcn file. It stays purely presentational — every piece of
   state arrives as a prop, nothing is read from a form context — because the
   JSON-Schema renderer that will drive these rows holds its own state and
   must be able to target them without dragging a form library in behind it.
   Adding a `useFormField()` here would make that impossible to undo later. */

import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Label } from './label'

function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('flex w-full flex-col gap-6', className)}
      {...props}
    />
  )
}

function Field({
  className,
  orientation = 'vertical',
  invalid,
  ...props
}: ComponentProps<'div'> & {
  orientation?: 'vertical' | 'horizontal'
  invalid?: boolean
}) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      data-invalid={invalid === true ? true : undefined}
      className={cn(
        'group/field flex w-full gap-2',
        'data-[orientation=vertical]:flex-col',
        'data-[orientation=horizontal]:flex-row data-[orientation=horizontal]:items-center data-[orientation=horizontal]:justify-between',
        'has-[:disabled]:opacity-60',
        className,
      )}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn('gap-1 group-data-[invalid]/field:text-destructive', className)}
      {...props}
    />
  )
}

function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        'text-sm leading-normal font-normal text-muted-foreground [&>a]:underline [&>a]:underline-offset-4',
        className,
      )}
      {...props}
    />
  )
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<'div'> & { errors?: readonly (string | undefined | null)[] }) {
  const list = errors?.filter((e): e is string => typeof e === 'string' && e.length > 0) ?? []
  const content: ReactNode =
    children ??
    (list.length === 0 ? null : list.length === 1 ? (
      list[0]
    ) : (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {list.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    ))
  if (content === null || content === undefined) return null
  return (
    <div
      data-slot="field-error"
      role="alert"
      className={cn('text-sm font-normal text-destructive', className)}
      {...props}
    >
      {content}
    </div>
  )
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel }
