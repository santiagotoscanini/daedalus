import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import type { SecretSetStatus } from '../../host/secret-set-request'
import { type AppSecretKey, secretKeyError } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'
// ./env-groups, NOT ./env-snapshot: this is client code, and env-snapshot
// imports node:fs/promises. Vite externalises node builtins for the browser,
// so importing a VALUE from that module — even a lookup table — makes the
// page throw on load. Type-only imports would be erased and safe; GROUP_LABELS
// is not.
import { ENV_GROUP_ORDER, type EnvGroup, type EnvOrigin, GROUP_LABELS } from '../../lib/env-groups'
import { when } from '../../lib/format'
import type { Result } from '../../lib/result'
import {
  fetchSecretSetStatus,
  removeAppSecretFn,
  revealEnvVar,
  setAppSecretFn,
} from '../../server/registry'
import { usePolledStatus } from '../status'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Board, BoardGrid } from '../viz'
import { VIZ_EMPTY } from './shared'

type EnvData = { available: boolean; takenAt: string | null; vars: EnvRowData[] }

/* A grid, not a table: `table-layout: auto` sizes the key column to its widest
   name and hands the leftover to the value, which is exactly backwards here —
   names are short and bounded, values are long and variable. Fixed columns
   instead, collapsing to stacked rows when there is no room for two. */
const ENV_TABLE = 'text-[0.85rem]'
const ENV_ROW =
  'grid grid-cols-[minmax(0,20rem)_minmax(0,1fr)] items-baseline gap-x-[1.25rem] gap-y-[0.35rem] border-b border-b-(--border-soft) py-2 last:border-b-0 max-[60rem]:grid-cols-[minmax(0,1fr)]'
const ENV_LEGEND = 'mt-0 mr-0 mb-[0.85rem] ml-0 text-[0.78rem] text-(--dim)'

/**
 * Everything the container actually has, grouped by who put it there — which
 * is the same question as who can change it.
 *
 * Read from the running container rather than re-derived from the registry:
 * that is the only place the four sources are already merged, and the point of
 * the page is to answer "what does this process actually see".
 */
export function Secrets({
  app,
  env,
  hasSecretsFile,
  secrets,
}: {
  app: string
  env: EnvData
  hasSecretsFile: boolean
  /** The KEYS of the sops file, from the file itself. Never a value. */
  secrets: AppSecretKey[]
}) {
  if (!env.available) {
    return (
      <BoardGrid>
        <Board title="Environment" icon="key" span={12}>
          <p className={VIZ_EMPTY}>
            No snapshot yet. Either the container is not running, or{' '}
            <code>daedalus-env-snapshot</code> has not run since it started (every 2 min).
          </p>
        </Board>
        {/* Still editable: the file is what the editor writes, and an app
            whose container is down is exactly when a wrong secret is being
            fixed. Only the LISTING of the live environment needs a snapshot. */}
        <OperatorSecrets app={app} keys={secrets} />
      </BoardGrid>
    )
  }

  const of = (o: EnvRowData['origin']) => env.vars.filter((v) => v.origin === o)
  const platform = of('platform')
  const groups = ENV_GROUP_ORDER.map((g) => ({
    g,
    vars: platform.filter((v) => v.group === g),
  })).filter((x) => x.vars.length > 0)

  return (
    <>
      <Alert className="mb-[1.35rem] border-info/35 bg-info/7 text-(--text-muted)">
        <AlertDescription>
          Injected at container start, not hot-reloaded. A change takes effect on the next deploy or
          Apply.
        </AlertDescription>
      </Alert>

      <BoardGrid>
        <Board
          title="Provided by daedalus"
          icon="◱"
          span={12}
          aside={
            env.takenAt ? (
              <span className="text-[0.72rem] tracking-normal text-(--dim) normal-case">
                read from the container {when(env.takenAt)}
              </span>
            ) : null
          }
        >
          <p className={ENV_LEGEND}>
            Injected by the apps platform from the toggles on Settings. Read-only here because they
            are not values so much as consequences: turn Postgres off and the whole database block
            goes with it. Secret values are withheld until revealed; they are never in this
            page&apos;s source.
          </p>
          {groups.map(({ g, vars }) => (
            <section key={g} className="mb-[1.4rem] last:mb-0">
              <h4 className="m-0 mb-[0.15rem] flex flex-wrap items-center gap-2 text-[0.82rem] font-semibold text-foreground">
                <span className="text-[0.95rem] leading-none text-primary" aria-hidden="true">
                  {GROUP_LABELS[g].icon}
                </span>
                {GROUP_LABELS[g].title}
                <span className="rounded-full border px-[0.4rem] text-[0.68rem] text-(--dim)">
                  {vars.length}
                </span>
              </h4>
              {GROUP_LABELS[g].hint && (
                <p className="mt-0 mr-0 mb-2 ml-0 text-[0.76rem] text-(--dim)">
                  {GROUP_LABELS[g].hint}
                </p>
              )}
              {/* Indented under its heading so the groups read as one list
                  broken into parts, rather than as separate tables that happen
                  to be adjacent. */}
              <div className={cn(ENV_TABLE, 'border-l border-l-(--border-soft) pl-[0.9rem]')}>
                {vars.map((v) => (
                  <EnvRow key={v.key} app={app} v={v} />
                ))}
              </div>
            </section>
          ))}
        </Board>

        <EnvSection
          title="Yours"
          icon="✎"
          vars={[...of('registry'), ...of('secrets')]}
          app={app}
          empty={
            hasSecretsFile
              ? `Nothing beyond what the platform injects. Add values to the registry (they round-trip through Apply) or to ${app}-env.sops.`
              : `Nothing beyond what the platform injects. Add plain values to the registry, or add the first secret below.`
          }
          legend={
            <>
              Declared in <code>apps.json</code>, so they round-trip through Apply, or read from{' '}
              <code>{app}-env.sops</code>. This is what the CONTAINER has; the board below is the
              file, which is where a secret is added, replaced or removed.
            </>
          }
        />

        <OperatorSecrets app={app} keys={secrets} />

        <EnvSection
          title="From the image"
          icon="◲"
          vars={of('image')}
          app={app}
          empty="Nothing. This image bakes in no environment of its own."
          legend={
            <>
              Baked into the base image or set by podman. Not configuration: these describe the
              runtime the app happens to be running on. Changing one means changing the image.
            </>
          }
        />
      </BoardGrid>
    </>
  )
}

function EnvSection({
  title,
  icon,
  vars,
  app,
  legend,
  empty,
}: {
  title: string
  icon: string
  vars: EnvRowData[]
  app: string
  legend: ReactNode
  empty: string
}) {
  return (
    <Board title={title} icon={icon} span={12}>
      {/* The empty copy already explains where these would come from, so
          showing the legend too says the same thing twice. */}
      {vars.length === 0 ? (
        <p className={VIZ_EMPTY}>{empty}</p>
      ) : (
        <>
          <p className={ENV_LEGEND}>{legend}</p>
          <div className={ENV_TABLE}>
            {vars.map((v) => (
              <EnvRow key={v.key} app={app} v={v} />
            ))}
          </div>
        </>
      )}
    </Board>
  )
}

type EnvRowData = {
  key: string
  origin: EnvOrigin
  group: EnvGroup
  secret: boolean
  note: string | null
  value: string | null
}

/**
 * One environment variable. A secret shows dots until revealed, and the value
 * is fetched at that moment rather than shipped with the page.
 */
function EnvRow({ app, v }: { app: string; v: EnvRowData }) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const shown = v.secret ? revealed : v.value

  return (
    <div className={ENV_ROW}>
      <div className="flex min-w-0 items-baseline gap-2 [&>code]:[overflow-wrap:anywhere]">
        <code>{v.key}</code>
        <span
          className={cn(
            'flex-none rounded-[4px] border px-[0.35rem] py-[0.05rem] text-[0.6rem] tracking-[0.08em] text-(--dim) uppercase',
            v.origin === 'registry' && 'border-primary/40 text-primary',
            v.origin === 'image' && 'opacity-55',
          )}
        >
          {v.origin}
        </span>
      </div>
      <div>
        <div className="flex min-w-0 items-center gap-2 [&>code]:[overflow-wrap:anywhere]">
          {shown === null ? (
            // Never break: dots carry no information, so wrapping them just
            // makes a column of them.
            <code className="tracking-[0.12em] whitespace-nowrap text-(--dim)">••••••••••••</code>
          ) : (
            <code>
              {shown === '' ? <span className="text-(--text-muted)">(empty)</span> : shown}
            </code>
          )}

          {v.secret && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto flex-none rounded-[6px] bg-(--panel-2) px-[0.4rem] py-[0.22rem] text-[0.72rem] leading-none hover:enabled:bg-(--raise) disabled:pointer-events-auto disabled:cursor-wait dark:bg-(--panel-2)"
              disabled={busy}
              title={revealed === null ? 'Reveal' : 'Hide'}
              aria-label={revealed === null ? `Reveal ${v.key}` : `Hide ${v.key}`}
              onClick={() => {
                if (revealed !== null) {
                  setRevealed(null)
                  return
                }
                setBusy(true)
                void revealEnvVar({ data: { name: app, key: v.key } })
                  .then((r) => {
                    setRevealed(r.value)
                  })
                  .finally(() => {
                    setBusy(false)
                  })
              }}
            >
              {revealed === null ? '👁' : '🙈'}
            </Button>
          )}
        </div>
        {v.note && (
          <p className="mt-[0.35rem] mr-0 mb-0 ml-0 text-[0.78rem] text-(--dim)">{v.note}</p>
        )}
      </div>
    </div>
  )
}

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

const SECRET_IDLE: SecretSetStatus = {
  id: null,
  app: null,
  key: null,
  action: null,
  state: 'idle',
  detail: '',
  error: '',
  commit: '',
  startedAt: null,
  finishedAt: null,
}

const FIELD = 'h-auto rounded-[6px] bg-(--panel-2) px-[0.5rem] py-[0.25rem] text-[0.8rem]'
const SMALL_BTN =
  'h-auto flex-none rounded-[6px] bg-(--panel-2) px-[0.45rem] py-[0.22rem] text-[0.72rem] leading-none hover:enabled:bg-(--raise) dark:bg-(--panel-2)'

export function OperatorSecrets({ app, keys }: { app: string; keys: AppSecretKey[] }) {
  const router = useRouter()
  const { status, running, refusal, start } = usePolledStatus<SecretSetStatus>({
    initial: SECRET_IDLE,
    fetch: () => fetchSecretSetStatus(),
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
      aside={
        busy ? (
          <span className="text-[0.72rem] tracking-normal text-(--dim) normal-case">working…</span>
        ) : null
      }
    >
      <p className={ENV_LEGEND}>
        The encrypted file behind the <code>secrets</code> rows above:{' '}
        <code>site/vault/apps/{app}-env.sops</code>. daedalus can seal a value into it and never
        read one back out — so a secret can be added, replaced or removed, never shown. To turn one
        back into a plain variable, remove it here and add it again on <b>Variables</b> — the same
        environment, the half that is committed in the clear.
      </p>

      {refusal !== null && (
        <Alert className="mb-[0.9rem] border-danger/35 bg-danger/7">
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      {refusal === null && status.state === 'failed' && (
        <Alert className="mb-[0.9rem] border-danger/35 bg-danger/7">
          <AlertDescription>
            {status.key === null ? '' : `${status.key}: `}
            {status.error}
          </AlertDescription>
        </Alert>
      )}
      {refusal === null && status.state === 'done' && status.detail !== '' && (
        <Alert className="mb-[0.9rem] border-info/35 bg-info/7 text-(--text-muted)">
          <AlertDescription>{status.detail}</AlertDescription>
        </Alert>
      )}

      <div className={ENV_TABLE}>
        {keys.length === 0 && (
          <p className={VIZ_EMPTY}>
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
                  <span className="text-[0.76rem] text-(--dim)">
                    {k.history === null
                      ? 'not in a commit yet'
                      : `set ${when(k.history.setAt)} by ${k.history.actor}`}
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

      <div className="mt-[0.9rem]">
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

      <p className="mt-[0.9rem] mr-0 mb-0 ml-0 text-[0.76rem] text-(--dim)">
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
 * and the host agent use, so the three cannot disagree about what a variable
 * name is. The value is a password field that starts empty, is never given a
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
  onSubmit: (submit: () => Promise<Result<string>>) => void
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
      {keyBad !== null && <span className="text-[0.76rem] text-danger">{keyBad}</span>}
    </form>
  )
}
