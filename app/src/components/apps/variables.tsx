import { useState } from 'react'
import { ENV_NOTE_MAX, type EnvVar, envKeyError, envValueError } from '../../lib/apps/env-vars'
import type { AppSecretKey } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'

import { saveApp } from '../../server/registry'
import { CELL_SUB, TABLE, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW } from '../table'
import { INPUT_ROW } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { SECTION_EXPLAIN, TabSection } from './section'
import type { AppRecord } from './shared'

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

const FIELD = INPUT_ROW
const SMALL_BTN = 'h-auto px-2.5 py-1 text-[0.75rem] text-subdued'
/** Name · value (its note under it) · the row's actions, in a column of their
    own so they line up down the table. */
const VAR_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,16rem)_minmax(0,1fr)_9.5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_9.5rem]',
)
/** The actions are there on hover or focus, and always on a touch screen: a
    column of Edit/Remove on every row was most of what the table drew. */
const ACTIONS =
  'flex items-center justify-end gap-1.5 whitespace-nowrap opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'
const KEY_CELL = 'min-w-0 font-mono text-[0.78rem] text-foreground [overflow-wrap:anywhere]'
const VALUE_CELL =
  'min-w-0 font-mono text-[0.78rem] text-subdued [overflow-wrap:anywhere] @max-[44rem]/table:col-start-1 @max-[44rem]/table:row-start-2'
const ROW_SPAN = 'col-start-2 col-end-4 min-w-0 py-1 @max-[44rem]/table:col-start-1'

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
  const vars = app.envVars
  const secretKeys = secrets.map((s) => s.key)

  // One editor open at a time: '' is the Add form, a key is that row, null is
  // neither — so "adding while editing" is not representable.
  const [form, setForm] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const { run, busy: saving, error } = useAction()

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
    run(() => saveApp({ data: { name: app.name, patch: { env: next } } }), { onDone: close })
  }

  const upsert = (draft: EnvVar, replacing: string | null) => {
    const next = vars.map((v) => ({ key: v.key, value: v.value, note: v.note }))
    const at = replacing === null ? -1 : next.findIndex((v) => v.key === replacing)
    if (at === -1) next.push(draft)
    else next[at] = draft
    write(next)
  }

  return (
    <TabSection
      first
      title="Variables"
      label="Variables"
      note="Plain environment, committed in the clear. A change reaches the container at the next Apply."
      aside={
        <>
          {saving && <span>saving…</span>}
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={saving || form === ''}
              onClick={() => {
                setConfirming(null)
                setForm('')
              }}
            >
              Add a variable
            </Button>
          )}
        </>
      }
    >
      <p className={SECTION_EXPLAIN}>
        The app's plain environment: committed in the clear in <code>site/apps.json</code>, merged
        into the container's environment by nix, and visible in <code>podman inspect</code>.
        Anything that should not be readable belongs in <b>Secrets</b> instead. A note is worth
        writing — it travels with the value into git, where it is the only explanation anyone will
        find. A change is saved here straight away and reaches the container at the next{' '}
        <b>Apply</b>, which writes <code>site/apps.json</code>, rebuilds and restarts it. Until then
        the Apps page shows this app as changed.
      </p>

      {error !== null && (
        <Alert className="mb-4 border-danger/35 bg-danger/7">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {readOnly && (
        <Alert className="mb-4">
          <AlertDescription>
            {app.name} is declared by hand in Nix, so its variables are read-only here.
          </AlertDescription>
        </Alert>
      )}

      <ul className={TABLE} aria-label="Variables">
        {vars.length > 0 && (
          <li className={cn(VAR_GRID, TABLE_HEAD)}>
            <span>Name</span>
            <span className="@max-[44rem]/table:hidden">Value</span>
            <span />
          </li>
        )}
        {vars.length === 0 && form !== '' && (
          <li className={TABLE_EMPTY}>
            No variables. Everything this app sees comes from the platform, its image, or its
            secrets.
          </li>
        )}
        {vars.map((v) => (
          <li className={cn(VAR_GRID, TABLE_ROW, 'gap-y-1')} key={v.key}>
            <code className={KEY_CELL}>{v.key}</code>
            {form === v.key ? (
              <div className={ROW_SPAN}>
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
                <div className={VALUE_CELL}>
                  {v.value}
                  {v.note !== null && v.note !== '' && (
                    <p className={cn(CELL_SUB, 'mt-0.5 font-sans whitespace-normal')}>{v.note}</p>
                  )}
                </div>
                <span
                  className={cn(
                    ACTIONS,
                    '@max-[44rem]/table:col-start-2 @max-[44rem]/table:row-start-1',
                    confirming === v.key && 'opacity-100',
                  )}
                >
                  {!readOnly && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
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
                          variant="destructive"
                          size="sm"
                          className={cn(SMALL_BTN, 'text-danger')}
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
                          variant="ghost"
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
                    </>
                  )}
                </span>
              </>
            )}
          </li>
        ))}
        {!readOnly && form === '' && (
          <li className={cn(TABLE_ROW, 'px-5 py-3')}>
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
          </li>
        )}
      </ul>
    </TabSection>
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
      {keyBad !== null && <span className="text-[0.75rem] text-danger">{keyBad}</span>}
      {valueBad !== null && <span className="text-[0.75rem] text-danger">{valueBad}</span>}
    </form>
  )
}
