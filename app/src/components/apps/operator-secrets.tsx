import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { RootAnswer } from '../../host/root'
import { type AppSecretKey, secretKeyError } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'
import { removeAppSecretFn, setAppSecretFn } from '../../server/registry'
import { When } from '../ago'
import { useRootAction } from '../root-action'
import { CELL_QUIET, TABLE, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW } from '../table'
import { INPUT_ROW } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SECTION_EXPLAIN, TabSection } from './section'

/* ── the operator-secrets editor ──────────────────────────────────────────
   Write-only, and not as a policy choice. daedalus holds an encrypt-only sops
   identity and no age key at all, so it can seal a value it will never be able
   to open. There is no reveal here and there cannot be one; what it CAN show
   is which keys the file holds, because a sops dotenv keeps its names in the
   clear (lib/apps/secret-keys.ts).

   Consequences worth knowing before reading the markup:
     · Replace is Add with the name fixed. One host verb serves both.
     · "Convert back to a plain variable" does not exist — nothing can read the
       value to move it. Remove it and type it again as a variable.
     · A value field is never populated from server data and is cleared on
       submit, so a password manager, a screenshot and view-source all see the
       same nothing. */

const FIELD = INPUT_ROW
const SMALL_BTN = 'h-auto flex-none rounded-[7px] px-2 py-1 text-[0.72rem] leading-none'
/** Name · when it was set · the row's actions. */
const SECRET_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,18rem)_minmax(0,1fr)_11rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_11rem]',
)

export function OperatorSecrets({ app, keys }: { app: string; keys: AppSecretKey[] }) {
  const router = useRouter()
  const { running, answer, start } = useRootAction({
    onSettle: () => {
      // The listing is loader data read off the file the host just rewrote.
      void router.invalidate()
    },
  })
  // Exactly one form is open at a time: '' means the Add form, a key means
  // Replace that key, null means neither. One piece of state rather than two
  // booleans, so "adding while replacing" is not representable.
  const [form, setForm] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const busy = running
  const close = () => {
    setForm(null)
    setConfirming(null)
  }

  return (
    <TabSection
      title="Operator secrets"
      label="Operator secrets"
      note={
        <>
          Write-only: sealed into <code>site/vault/apps/{app}-env.sops</code>, never read back.
        </>
      }
      aside={
        <>
          {busy && <span>working…</span>}
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={busy || form === ''}
            onClick={() => {
              setConfirming(null)
              setForm('')
            }}
          >
            Add a secret
          </Button>
        </>
      }
    >
      <p className={SECTION_EXPLAIN}>
        The encrypted file behind the <code>secrets</code> rows above:{' '}
        <code>site/vault/apps/{app}-env.sops</code>. daedalus can seal a value into it and never
        read one back out — so a secret can be added, replaced or removed, never shown. To turn one
        back into a plain variable, remove it here and add it again on <b>Variables</b> — the same
        environment, the half that is committed in the clear. A write commits the encrypted file
        straight away; the container picks the new value up on the next Apply, which is what
        rebuilds and restarts it.
      </p>

      {answer !== null && answer.outcome !== 'done' && (
        <Alert className="mb-4 border-danger/35 bg-danger/7">
          <AlertDescription>
            {answer.detail === '' ? `the write ${answer.outcome}` : answer.detail}
          </AlertDescription>
        </Alert>
      )}
      {answer !== null && answer.outcome === 'done' && answer.detail !== '' && (
        <Alert className="mb-4 border-info/35 bg-info/7 text-subdued">
          <AlertDescription>{answer.detail}</AlertDescription>
        </Alert>
      )}

      <ul className={TABLE} aria-label="Operator secrets">
        <li className={cn(SECRET_GRID, TABLE_HEAD)}>
          <span>Name</span>
          <span className="@max-[44rem]/table:hidden">Set</span>
          <span />
        </li>
        {keys.length === 0 && form !== '' && (
          <li className={TABLE_EMPTY}>
            No operator secrets yet. The file is created by the first key you add.
          </li>
        )}
        {keys.map((k) => (
          <li className={cn(SECRET_GRID, TABLE_ROW)} key={k.key}>
            <code className="min-w-0 font-mono text-[0.78rem] text-foreground [overflow-wrap:anywhere]">
              {k.key}
            </code>
            {form === k.key ? (
              <div className="col-start-2 col-end-4 min-w-0 py-1 @max-[44rem]/table:col-start-1">
                <SecretForm
                  app={app}
                  fixedKey={k.key}
                  busy={busy}
                  onCancel={close}
                  onSubmit={(submit) => {
                    close()
                    start(submit)
                  }}
                />
              </div>
            ) : (
              <>
                <span className={cn(CELL_QUIET, 'truncate @max-[44rem]/table:hidden')}>
                  {k.history === null ? (
                    'not in a commit yet'
                  ) : (
                    <>
                      <When at={k.history.setAt} /> by {k.history.actor}
                    </>
                  )}
                </span>
                <span
                  className={cn(
                    'flex items-center justify-end gap-1.5 whitespace-nowrap opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
                    confirming === k.key && 'opacity-100',
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={SMALL_BTN}
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null)
                      setForm(k.key)
                    }}
                  >
                    Replace
                  </Button>
                  {confirming === k.key ? (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className={SMALL_BTN}
                      disabled={busy}
                      onClick={() => {
                        close()
                        start(() => removeAppSecretFn({ data: { name: app, key: k.key } }))
                      }}
                    >
                      Confirm remove
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={SMALL_BTN}
                      disabled={busy}
                      onClick={() => {
                        setForm(null)
                        setConfirming(k.key)
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
        {form === '' && (
          <li className={cn(TABLE_ROW, 'px-5 py-3')}>
            <SecretForm
              app={app}
              fixedKey={null}
              busy={busy}
              onCancel={close}
              onSubmit={(submit) => {
                close()
                start(submit)
              }}
            />
          </li>
        )}
      </ul>
    </TabSection>
  )
}

/**
 * Name + value, or value alone when the name is fixed (Replace).
 *
 * The name is validated as you type with the same function the server function
 * uses (lib/apps/secret-keys.ts, which also names the host agent's third
 * check), so the form cannot accept a name the server refuses. The value is a password field that starts empty, is never given a
 * value from the server, and goes out of scope with the form.
 */
function SecretForm({
  app,
  fixedKey,
  busy,
  onCancel,
  onSubmit,
}: {
  app: string
  fixedKey: string | null
  busy: boolean
  onCancel: () => void
  onSubmit: (submit: () => Promise<RootAnswer>) => void
}) {
  const [key, setKey] = useState(fixedKey ?? '')
  const [value, setValue] = useState('')
  const keyBad = key === '' ? null : secretKeyError(key)
  const ready = !busy && value !== '' && (fixedKey !== null || (key !== '' && keyBad === null))

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        const data = { name: app, key: fixedKey ?? key, value }
        // Cleared before the request is even made: nothing keeps the plaintext
        // alive in component state past the click.
        setValue('')
        onSubmit(() => setAppSecretFn({ data }))
      }}
    >
      {fixedKey === null && (
        <Input
          className={cn(FIELD, 'w-[14rem] font-mono')}
          placeholder="VARIABLE_NAME"
          aria-label="Variable name"
          value={key}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setKey(e.target.value)
          }}
        />
      )}
      <Input
        className={cn(FIELD, 'w-[18rem]')}
        type="password"
        placeholder={fixedKey === null ? 'value' : `new value for ${fixedKey}`}
        aria-label={fixedKey === null ? 'Value' : `New value for ${fixedKey}`}
        value={value}
        autoComplete="new-password"
        onChange={(e) => {
          setValue(e.target.value)
        }}
      />
      <Button type="submit" variant="outline" size="sm" className={SMALL_BTN} disabled={!ready}>
        {fixedKey === null ? 'Add' : 'Replace'}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={SMALL_BTN}
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </Button>
      {keyBad !== null && <span className="text-[0.75rem] text-danger">{keyBad}</span>}
    </form>
  )
}

/* The environment tables: name and value in fixed columns — names are short
   and bounded, values long and variable — with the origin in a narrow column
   where a table mixes origins. The value drops under the name on a phone. */
export const ENV_TABLE = TABLE

export const ENV_ROW = cn(
  'grid items-center gap-x-6 gap-y-1 px-5',
  'grid-cols-[minmax(0,18rem)_minmax(0,1fr)]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)]',
)

/** The prose that opens an env section: what the rows are and where they come
    from. Explanation, so it folds behind the section's ⓘ. */
export const ENV_LEGEND = SECTION_EXPLAIN
