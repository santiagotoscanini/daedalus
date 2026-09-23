import { useState } from 'react'

import { cn } from '../../lib/cn'
import { useShown } from '../../lib/shown'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './select'

// A closed list to pick one value from: the one way this app draws a
// dropdown, over the Radix Select underneath.
//
// Two things the raw Select does not do, and every caller wants:
//
// - The list is built only while it is open. Radix renders a closed
//   Select's items into a hidden fragment so the trigger can find the
//   chosen item's text; with the six hundred timezones that was a quarter
//   of a second on every visit to the tab that holds it. The trigger is
//   told its text here instead, and the items exist only when they can be
//   seen.
// - A value the list does not carry (a zone the token stopped seeing, a
//   name tzdata renamed) is still shown, in a group of its own, rather
//   than leaving an empty trigger that reads as "not set".

export type PickerOption = { value: string; label: string }
export type PickerGroup = { label: string; options: PickerOption[] }

type Props = {
  value: string
  onChange: (value: string) => void
  /** Flat, or grouped; a single group is drawn without its heading. */
  options: PickerOption[] | PickerGroup[]
  /** What the trigger says while nothing is chosen. */
  placeholder?: string
  disabled?: boolean
  /**
   * The save a choice started is still running: the choice stays shown
   * until it is over (lib/shown.ts). A picker whose parent applies the
   * value at once leaves this out.
   */
  busy?: boolean
  /** That save failed: the shown choice gives way to the saved value. */
  failed?: boolean
  id?: string
  'aria-label'?: string
  className?: string
  /** For lists of identifiers, which read better in the code face. */
  mono?: boolean
}

function grouped(options: Props['options']): PickerGroup[] {
  const first = options[0]
  if (first === undefined) return []
  return 'options' in first
    ? (options as PickerGroup[])
    : [{ label: '', options: options as PickerOption[] }]
}

export function Picker({
  value: saved,
  onChange,
  options,
  placeholder,
  disabled,
  busy = false,
  failed = false,
  id,
  className,
  mono,
  ...aria
}: Props) {
  const [open, setOpen] = useState(false)
  const [value, pick] = useShown(saved, busy, failed)
  const groups = grouped(options)
  const chosen = groups.flatMap((g) => g.options).find((o) => o.value === value)
  const shown =
    chosen !== undefined || value === ''
      ? groups
      : [{ label: 'Current', options: [{ value, label: value }] }, ...groups]
  const itemClass = mono === true ? 'font-mono text-[0.8rem]' : undefined

  return (
    <Select
      value={value}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      onValueChange={(v) => {
        if (v === value) return
        pick(v)
        onChange(v)
      }}
    >
      <SelectTrigger
        id={id}
        size="sm"
        aria-label={aria['aria-label']}
        className={cn('w-full justify-between', className)}
      >
        <SelectValue placeholder={placeholder}>
          {value === '' ? undefined : <span className={itemClass}>{chosen?.label ?? value}</span>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {open &&
          shown.map((g) => (
            <SelectGroup key={g.label}>
              {shown.length > 1 && g.label !== '' && <SelectLabel>{g.label}</SelectLabel>}
              {g.options.map((o) => (
                <SelectItem key={o.value} value={o.value} className={itemClass}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
      </SelectContent>
    </Select>
  )
}
