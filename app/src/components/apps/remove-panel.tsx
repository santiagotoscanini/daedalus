import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useId, useState } from 'react'
import { deleteAppFn } from '../../server/registry'
import { TypedConfirm } from '../armed-confirm'
import { INPUT_FORM } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { Board } from '../viz'

/**
 * Remove the app from the registry.
 *
 * Confirm-by-typing rather than a dialog: the cost of this is not the click,
 * it is that the next Apply takes the app off the box, and typing the name is
 * the cheapest way to make sure the app being removed is the app you are
 * looking at.
 *
 * The honest part is the list of what does NOT go away. `deleteApp` removes a
 * declaration (and the rows that cascade from it); the postgres database, the
 * data directory, the machine-state secrets and any sops file outlive it, because a UI button should not be able to destroy data that
 * takes a restore to get back. Reclaiming them stays a deliberate act at a
 * shell, and the panel says so instead of leaving you to find out.
 */
export function RemovePanel({
  name,
  postgres,
  storage,
  dataDir,
}: {
  name: string
  postgres: boolean
  storage: boolean
  dataDir: string
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const { run, busy, error } = useAction()

  const remove = () => {
    run(() => deleteAppFn({ data: { name } }), {
      invalidate: false,
      onDone: () => router.navigate({ to: '/apps' }),
    })
  }

  return (
    <Board title="Remove" icon="⌫" span={12}>
      {/* The explanation and the control side by side rather than stacked: what
          is NOT removed is the part worth reading, and it has to be in view at
          the moment the name is being typed rather than scrolled past to reach
          the box. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] items-start gap-6 max-[50rem]:grid-cols-[minmax(0,1fr)]">
        <div className="[&>p]:mt-0 [&>p]:mr-0 [&>p]:mb-2 [&>p]:ml-0 [&>p]:text-[0.85rem] [&>p]:leading-[1.55] [&>p]:text-subdued">
          <p>
            Deletes the registry entry with its variables, tasks, build and deploy history, and its
            link to the GitHub repository. The next Apply removes the container, the traefik router,
            the pi-hole record, the gatus probe and the Cloudflare route.
          </p>
          <p className="mb-0 text-[0.75rem] leading-[1.5] text-muted-foreground">
            <b>Not removed:</b>{' '}
            {[
              postgres && `the ${name} database and role on the shared cluster`,
              storage && dataDir,
              'its generated secrets in the box’s machine state',
              `any site/vault/apps/${name}-env.sops`,
              'the GitHub repo and its images in the box’s registry',
            ]
              .filter((s): s is string => typeof s === 'string')
              .join(', ')}
            . Those are data, and removing them is a separate, deliberate act. An app created again
            under the same name picks them back up.
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2.5">
          <TypedConfirm
            name={name}
            value={confirm}
            onChange={setConfirm}
            className="flex-col items-stretch gap-1"
            inputClassName="w-full"
          />
          {error !== null && (
            <Alert variant="warning" className="mb-5 text-foreground">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* Destructive, and coloured like it — but only on hover, so the
              panel does not read as an alarm just for existing. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-danger/50 bg-transparent text-[0.84rem] text-danger hover:bg-danger/12 hover:text-danger dark:bg-transparent"
            disabled={confirm !== name || busy}
            onClick={remove}
          >
            {busy ? 'Removing…' : 'Remove from registry'}
          </Button>
        </div>
      </div>
    </Board>
  )
}

/** Text input that commits on blur or Enter — no per-keystroke writes. */
export function TextField({
  label,
  value,
  placeholder,
  hint,
  disabled,
  validate,
  onSave,
}: {
  label: string
  value: string
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
  /** Returns an operator-facing reason, or null when the value is usable. */
  validate?: (v: string) => string | null
  onSave: (v: string) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const error = validate ? validate(draft) : null

  return (
    // `has-[:disabled]:opacity-100`: a disabled row dims its INPUT, not its
    // label — the label is what says which field is locked.
    <Field className="gap-1 py-2 has-[:disabled]:opacity-100">
      <FieldLabel htmlFor={id} className="text-[0.75rem] font-normal text-muted-foreground">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="text"
        className={INPUT_FORM}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={() => {
          // A rejected value stays in the box rather than being saved or
          // silently reverted — the operator can see what they typed and fix
          // it. Escape is the way out.
          if (error !== null) return
          if (draft !== value) onSave(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
      {error !== null ? (
        <FieldError className="text-[0.75rem] leading-[1.5]">{error}</FieldError>
      ) : (
        hint !== undefined && (
          <FieldDescription className="text-[0.75rem] leading-[1.5]">{hint}</FieldDescription>
        )
      )}
    </Field>
  )
}
