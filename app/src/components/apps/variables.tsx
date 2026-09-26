import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ENV_NOTE_MAX, type EnvVar, envKeyError, envValueError } from '../../lib/apps/env-vars'
import type { AppSecretKey } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/redact'
import { saveApp } from '../../server/registry'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Board, BoardGrid } from '../viz'
import type { AppRecord } from './shared'
import { VIZ_EMPTY } from './shared'

// The plain half of an app's environment: what is NOT a secret, and so can be
// read, changed and diffed in the open.
//
// The mirror of the Secrets tab beside it, and deliberately its opposite in
// every way that matters. A secret is write-only because daedalus holds only
// an encrypt-only sops identity; a variable is a row in Postgres, shown in
// full, exported into site/apps.json by an Apply and committed in the clear.
// So this editor shows values, and the one thing it refuses is a name the
// sops file already holds — which would put a secret's value in the clear
// beside its encrypted one.
//
// A write lands in Postgres immediately and in the app's environment only at
// the next Apply, which is what rebuilds and restarts the container. The page
// says so rather than implying a live change, and the Apps bar lights because
// `driftOf` compares these rows against the nix manifest.

const FIELD = 'h-auto rounded-[6px] bg-(--panel-2) px-[0.5rem] py-[0.25rem] text-[0.8rem]'
const SMALL_BTN = 'h-auto px-[0.6rem] py-[0.2rem] text-[0.76rem] text-(--text-muted)'
const LEGEND = 'mt-0 mr-0 mb-[0.85rem] ml-0 text-[0.78rem] text-(--dim)'
// Three columns, not two: the name, the value, and the actions in a column
// of their own so they line up down the page. Trailing the buttons after the
// value put them at a different x in every row and wrapped them onto a second
// line whenever a value was long — a Mapbox token is long — which made one
// row taller than its neighbours for no reason a reader could use.
const ROW =
  'grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] items-baseline gap-x-[1.25rem] gap-y-[0.15rem] border-b border-b-(--border-soft) py-[0.6rem] last:border-b-0 max-[60rem]:grid-cols-[minmax(0,1fr)_auto]'
/** The note belongs under the value, not beside the key, and needs air above it. */
const NOTE_CELL =
  'col-start-2 col-end-4 mt-[0.35rem] mb-0 text-[0.76rem] leading-[1.45] text-(--dim) max-[60rem]:col-start-1'

export function Variables({
  app,
  readOnly,
  secrets,
}: {
  app: AppRecord
  readOnly: boolean
  /** The KEYS of the sops file. A variable may not take one of these names. */
  secrets: AppSecretKey[]
}) {
  const router = useRouter()
  const vars = app.envVars
  const secretKeys = secrets.map((s) => s.key)

  // One editor open at a time: '' is the Add form, a key is that row, null is
  // neither — so "adding while editing" is not representable.
  const [form, setForm] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    setForm(null)
    setConfirming(null)
  }

  /**
   * Write the WHOLE list back, as the task editor does and for the same
   * reason: `updateApp` replaces the rows, so a partial send would delete
   * everything omitted. The boundary's refusal is shown as it came back —
   * those sentences are the ones the form shows while you type.
   */
  const write = (next: EnvVar[]) => {
    setSaving(true)
    setError(null)
    void saveApp({ data: { name: app.name, patch: { env: next } } })
      .then(async () => {
        close()
        await router.invalidate()
      })
      .catch((e: unknown) => {
        setError(errorText(e))
      })
      .finally(() => {
        setSaving(false)
      })
  }

  const upsert = (draft: EnvVar, replacing: string | null) => {
    const next = vars.map((v) => ({ key: v.key, value: v.value, note: v.note }))
    const at = replacing === null ? -1 : next.findIndex((v) => v.key === replacing)
    if (at === -1) next.push(draft)
    else next[at] = draft
    write(next)
  }

  return (
    <BoardGrid>
      <Board
        title="Variables"
        icon="rows"
        span={12}
        aside={
          saving ? (
            <span className="text-[0.72rem] tracking-normal text-(--dim) normal-case">saving…</span>
          ) : null
        }
      >
        <p className={LEGEND}>
          The app's plain environment: committed in the clear in <code>site/apps.json</code>, merged
          into the container's environment by nix, and visible in <code>podman inspect</code>.
          Anything that should not be readable belongs in <b>Secrets</b> instead. A note is worth
          writing — it travels with the value into git, where it is the only explanation anyone will
          find.
        </p>

        {error !== null && (
          <Alert className="mb-[0.9rem] border-danger/35 bg-danger/7">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {readOnly && (
          <Alert className="mb-[0.9rem]">
            <AlertDescription>
              {app.name} is declared by hand in Nix, so its variables are read-only here.
            </AlertDescription>
          </Alert>
        )}

        <div className="text-[0.85rem]">
          {vars.length === 0 && (
            <p className={VIZ_EMPTY}>
              No variables. Everything this app sees comes from the platform, its image, or its
              secrets.
            </p>
          )}
          {vars.map((v) => (
            <div className={ROW} key={v.key}>
              <div className="flex min-w-0 items-baseline gap-2 [&>code]:[overflow-wrap:anywhere]">
                <code>{v.key}</code>
              </div>
              {form === v.key ? (
                <div className="col-start-2 col-end-4 min-w-0 max-[60rem]:col-start-1">
                  <VariableForm
                    fixedKey={v.key}
                    initial={v}
                    taken={vars.filter((o) => o.key !== v.key).map((o) => o.key)}
                    secretKeys={secretKeys}
                    busy={saving}
                    onCancel={close}
                    onSubmit={(draft) => {
                      upsert(draft, v.key)
                    }}
                  />
                </div>
              ) : (
                <>
                  <span className="min-w-0 [overflow-wrap:anywhere]">{v.value}</span>
                  {!readOnly && (
                    <span className="flex items-baseline gap-2 justify-self-end whitespace-nowrap">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={SMALL_BTN}
                        disabled={saving}
                        onClick={() => {
                          setConfirming(null)
                          setForm(v.key)
                        }}
                      >
                        Edit
                      </Button>
                      {confirming === v.key ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={cn(SMALL_BTN, 'border-danger/50 text-danger')}
                          disabled={saving}
                          onClick={() => {
                            write(
                              vars
                                .filter((o) => o.key !== v.key)
                                .map((o) => ({ key: o.key, value: o.value, note: o.note })),
                            )
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
                          disabled={saving}
                          onClick={() => {
                            setForm(null)
                            setConfirming(v.key)
                          }}
                        >
                          Remove
                        </Button>
                      )}
                    </span>
                  )}
                  {v.note !== null && v.note !== '' && <p className={NOTE_CELL}>{v.note}</p>}
                </>
              )}
            </div>
          ))}
        </div>

        {!readOnly && (
          <div className="mt-[0.9rem]">
            {form === '' ? (
              <VariableForm
                fixedKey={null}
                initial={null}
                taken={vars.map((v) => v.key)}
                secretKeys={secretKeys}
                busy={saving}
                onCancel={close}
                onSubmit={(draft) => {
                  upsert(draft, null)
                }}
              />
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={SMALL_BTN}
                disabled={saving}
                onClick={() => {
                  setConfirming(null)
                  setForm('')
                }}
              >
                + Add a variable
              </Button>
            )}
          </div>
        )}

        <p className="mt-[0.9rem] mr-0 mb-0 ml-0 text-[0.76rem] text-(--dim)">
          A change is saved here straight away and reaches the container at the next <b>Apply</b>,
          which writes <code>site/apps.json</code>, rebuilds and restarts it. Until then the Apps
          page shows this app as changed.
        </p>
      </Board>
    </BoardGrid>
  )
}

/**
 * Name, value and note — the name fixed when editing an existing variable,
 * because renaming one is removing it and adding another, and the row this
 * form sits in says which variable it is.
 *
 * Validated as you type with the same functions the server function uses, so
 * the form and its boundary cannot come to disagree about what is allowed.
 */
function VariableForm({
  fixedKey,
  initial,
  taken,
  secretKeys,
  busy,
  onCancel,
  onSubmit,
}: {
  fixedKey: string | null
  initial: EnvVar | null
  taken: string[]
  secretKeys: string[]
  busy: boolean
  onCancel: () => void
  onSubmit: (draft: EnvVar) => void
}) {
  const [key, setKey] = useState(initial?.key ?? '')
  const [value, setValue] = useState(initial?.value ?? '')
  const [note, setNote] = useState(initial?.note ?? '')

  const keyBad = fixedKey !== null || key === '' ? null : envKeyError(key, taken, secretKeys)
  const valueBad = envValueError(value)
  const ready = !busy && valueBad === null && (fixedKey !== null || (key !== '' && keyBad === null))

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        onSubmit({
          key: fixedKey ?? key,
          value,
          note: note.trim() === '' ? null : note.trim(),
        })
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
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
          className={cn(FIELD, 'w-[22rem]')}
          placeholder="value"
          aria-label={fixedKey === null ? 'Value' : `Value of ${fixedKey}`}
          value={value}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value)
          }}
        />
        <Button type="submit" variant="outline" size="sm" className={SMALL_BTN} disabled={!ready}>
          {fixedKey === null ? 'Add' : 'Save'}
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
      </div>
      <Input
        className={cn(FIELD, 'w-full max-w-[42rem]')}
        placeholder="why this value is what it is (optional)"
        aria-label={fixedKey === null ? 'Note' : `Note for ${fixedKey}`}
        value={note}
        maxLength={ENV_NOTE_MAX}
        onChange={(e) => {
          setNote(e.target.value)
        }}
      />
      {keyBad !== null && <span className="text-[0.76rem] text-danger">{keyBad}</span>}
      {valueBad !== null && <span className="text-[0.76rem] text-danger">{valueBad}</span>}
    </form>
  )
}
