import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { RootAnswer } from '../../host/root'
import { type AppSecretKey, secretKeyError } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'
import { removeAppSecretFn, setAppSecretFn } from '../../server/registry'
import { When } from '../ago'
import { useRootAction } from '../root-action'
import { EMPTY, INPUT_ROW } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Board } from '../viz'

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
    <Board
      title="Operator secrets"
      icon="⚿"
      span={12}
      aside={busy ? <span className="text-[0.75rem] text-muted-foreground">working…</span> : null}
    >
      <p className={ENV_LEGEND}>
        The encrypted file behind the <code>secrets</code> rows above:{' '}
        <code>site/vault/apps/{app}-env.sops</code>. daedalus can seal a value into it and never
        read one back out — so a secret can be added, replaced or removed, never shown. To turn one
        back into a plain variable, remove it here and add it again on <b>Variables</b> — the same
        environment, the half that is committed in the clear.
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

      <div className={ENV_TABLE}>
        {keys.length === 0 && (
          <p className={EMPTY}>
            No operator secrets yet. The file is created by the first key you add.
          </p>
        )}
        {keys.map((k) => (
          <div className={ENV_ROW} key={k.key}>
            <div className="flex min-w-0 items-baseline gap-2 [&>code]:[overflow-wrap:anywhere]">
              <code>{k.key}</code>
            </div>
            <div>
              {form === k.key ? (
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
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[0.75rem] text-muted-foreground">
                    {k.history === null ? (
                      'not in a commit yet'
                    ) : (
                      <>
                        set <When at={k.history.setAt} /> by {k.history.actor}
                      </>
                    )}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
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
                      variant="outline"
                      size="sm"
                      className={cn(SMALL_BTN, 'border-danger/50 text-danger')}
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
                      variant="outline"
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
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        {form === '' ? (
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
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={SMALL_BTN}
            disabled={busy}
            onClick={() => {
              setConfirming(null)
              setForm('')
            }}
          >
            + Add a secret
          </Button>
        )}
      </div>

      <p className="explain mt-4 mr-0 mb-0 ml-0 max-w-[72ch] text-[0.78rem] leading-[1.55] text-muted-foreground">
        A write commits the encrypted file straight away; the container picks the new value up on
        the next Apply, which is what rebuilds and restarts it.
      </p>
    </Board>
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

/* A grid, not a table: `table-layout: auto` sizes the key column to its widest
   name and hands the leftover to the value, which is exactly backwards here —
   names are short and bounded, values are long and variable. Fixed columns
   instead, collapsing to stacked rows when there is no room for two. */
export const ENV_TABLE = 'text-[0.85rem]'

export const ENV_ROW =
  'grid grid-cols-[minmax(0,20rem)_minmax(0,1fr)] items-baseline gap-x-5 gap-y-1.5 border-hairline border-b py-2.5 last:border-b-0 max-[60rem]:grid-cols-[minmax(0,1fr)]'

/** The prose that opens an env board: what the rows are and where they come from.
    Explanation, so it folds behind the board's ⓘ. */
export const ENV_LEGEND =
  'explain mt-0 mr-0 mb-3 ml-0 max-w-[72ch] text-[0.78rem] leading-[1.55] text-muted-foreground'
