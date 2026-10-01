import { type ReactNode, useId } from 'react'
import { INPUT_FORM } from '../tokens'
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'

/**
 * A plain controlled field.
 *
 * Not the TextField from the app detail page: that one saves on blur because
 * it edits a record that already exists, and every keystroke here belongs to a
 * form that has not been submitted yet.
 */
export function WizardField({
  label,
  value,
  placeholder,
  hint,
  disabled,
  validate,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
  validate?: (v: string) => string | null
  onChange: (v: string) => void
}) {
  const id = useId()
  const error = validate ? validate(value) : null
  return (
    // `has-[:disabled]:opacity-100`: the Name row is disabled by design — the
    // repo decides it — and dimming its label would say "locked" about the one
    // field the reader most needs to read. The input dims itself.
    <Field className="gap-[0.3rem] py-2 has-[:disabled]:opacity-100">
      <FieldLabel htmlFor={id} className="text-[0.76rem] font-normal text-muted-foreground">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="text"
        className={INPUT_FORM}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      {error !== null ? (
        <FieldError className="text-[0.76rem] leading-[1.45]">{error}</FieldError>
      ) : (
        hint !== undefined && (
          <FieldDescription className="text-[0.76rem] leading-[1.45]">{hint}</FieldDescription>
        )
      )}
    </Field>
  )
}
