import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/cn'
// ./env-groups, NOT ./env-snapshot: this is client code, and env-snapshot
// imports node:fs/promises. Vite externalises node builtins for the browser,
// so importing a VALUE from that module — even a lookup table — makes the
// page throw on load. Type-only imports would be erased and safe; GROUP_LABELS
// is not.
import { type EnvGroup, type EnvOrigin, GROUP_LABELS } from '../../lib/env-groups'
import { when } from '../../lib/format'
import { revealEnvVar } from '../../server/registry'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
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
}: {
  app: string
  env: EnvData
  hasSecretsFile: boolean
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
      </BoardGrid>
    )
  }

  const of = (o: EnvRowData['origin']) => env.vars.filter((v) => v.origin === o)
  const platform = of('platform')
  const groups = GROUP_ORDER.map((g) => ({
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
              : `Nothing beyond what the platform injects. Add plain values to the registry, or create ${app}-env.sops for anything secret.`
          }
          legend={
            <>
              Declared in <code>apps.json</code>, so they round-trip through Apply, or read from{' '}
              <code>{app}-env.sops</code>. The sops ones are host-managed on purpose: writing
              encrypted state from a web UI is its own design problem, and it is one that fails
              closed. Edit them with <code>sops stacks/apps/{app}-env.sops</code>.
            </>
          }
        />

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

const GROUP_ORDER = [
  'identity',
  'database',
  'auth',
  'sso',
  'litellm',
  'observability',
  'other',
] as const

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
