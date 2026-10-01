import { type ReactNode, useState } from 'react'
import type { AppSecretKey } from '../../lib/apps/secret-keys'
import { cn } from '../../lib/cn'
// lib/env-groups, NOT host/env-snapshot: this is client code, and a VALUE
// import from the module that reads the disk (GROUP_LABELS is one) pulls node
// builtins into the browser bundle and the page throws on load. Type-only
// imports would be erased and safe.
import { ENV_GROUP_ORDER, type EnvGroup, type EnvOrigin, GROUP_LABELS } from '../../lib/env-groups'
import { revealEnvVar } from '../../server/registry'
import { When } from '../ago'
import { EMPTY } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
import { Board, BoardGrid } from '../viz'
import { ENV_LEGEND, ENV_ROW, ENV_TABLE, OperatorSecrets } from './operator-secrets'

type EnvData = { available: boolean; takenAt: string | null; vars: EnvRowData[] }

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
          <p className={EMPTY}>
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
      <Alert className="mb-[1.35rem] border-info/35 bg-info/7 text-subdued">
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
              <span className="text-[0.72rem] tracking-normal text-muted-foreground normal-case">
                read from the container {<When at={env.takenAt} />}
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
                <span className="rounded-full border px-[0.4rem] text-[0.68rem] text-muted-foreground">
                  {vars.length}
                </span>
              </h4>
              {GROUP_LABELS[g].hint && (
                <p className="mt-0 mr-0 mb-2 ml-0 text-[0.76rem] text-muted-foreground">
                  {GROUP_LABELS[g].hint}
                </p>
              )}
              {/* Indented under its heading so the groups read as one list
                  broken into parts, rather than as separate tables that happen
                  to be adjacent. */}
              <div className={cn(ENV_TABLE, 'border-l border-l-subtle pl-[0.9rem]')}>
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
        <p className={EMPTY}>{empty}</p>
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
  const { run, busy, error } = useAction()

  const shown = v.secret ? revealed : v.value

  return (
    <div className={ENV_ROW}>
      <div className="flex min-w-0 items-baseline gap-2 [&>code]:[overflow-wrap:anywhere]">
        <code>{v.key}</code>
        <span
          className={cn(
            'flex-none rounded-[4px] border px-[0.35rem] py-[0.05rem] text-[0.6rem] tracking-[0.08em] text-muted-foreground uppercase',
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
            <code className="tracking-[0.12em] whitespace-nowrap text-muted-foreground">
              ••••••••••••
            </code>
          ) : (
            <code>{shown === '' ? <span className="text-subdued">(empty)</span> : shown}</code>
          )}

          {v.secret && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto flex-none rounded-[6px] bg-raised px-[0.4rem] py-[0.22rem] text-[0.72rem] leading-none hover:enabled:bg-lifted disabled:pointer-events-auto disabled:cursor-wait dark:bg-raised"
              disabled={busy}
              title={revealed === null ? 'Reveal' : 'Hide'}
              aria-label={revealed === null ? `Reveal ${v.key}` : `Hide ${v.key}`}
              onClick={() => {
                if (revealed !== null) {
                  setRevealed(null)
                  return
                }
                run(() => revealEnvVar({ data: { name: app, key: v.key } }), {
                  invalidate: false,
                  onDone: (r) => {
                    setRevealed(r.value)
                  },
                })
              }}
            >
              {revealed === null ? '👁' : '🙈'}
            </Button>
          )}
        </div>
        {error !== null && (
          <p className="mt-[0.35rem] mr-0 mb-0 ml-0 text-[0.78rem] text-danger">{error}</p>
        )}
        {v.note && (
          <p className="mt-[0.35rem] mr-0 mb-0 ml-0 text-[0.78rem] text-muted-foreground">
            {v.note}
          </p>
        )}
      </div>
    </div>
  )
}
