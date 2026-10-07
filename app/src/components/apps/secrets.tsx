import { EyeIcon, EyeOffIcon } from 'lucide-react'
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
import { CELL_SUB, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW, TableGroup } from '../table'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
import { ENV_LEGEND, ENV_ROW, ENV_TABLE, OperatorSecrets } from './operator-secrets'
import { TabSection } from './section'

type EnvData = { available: boolean; takenAt: string | null; vars: EnvRowData[] }

/** A table that mixes origins carries them in a narrow third column. */
const ORIGIN_ROW = cn(
  ENV_ROW,
  'grid-cols-[minmax(0,18rem)_minmax(0,1fr)_5.5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_5.5rem]',
)
const KEY = 'min-w-0 font-mono text-[0.78rem] text-foreground [overflow-wrap:anywhere]'

/**
 * Everything the container actually has, grouped by who put it there — which
 * is the same question as who can change it.
 *
 * Read from the running container rather than re-derived from the registry:
 * that is the only place the four sources are already merged, and the point of
 * the page is to answer "what does this process actually see".
 *
 * One table per origin, the origin named once in its title rather than as a
 * pill on every row; the platform's table breaks into its groups.
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
      <>
        <TabSection title="Environment" first>
          <ul className={ENV_TABLE}>
            <li className={TABLE_EMPTY}>
              No snapshot yet. Either the container is not running, or{' '}
              <code>daedalus-env-snapshot</code> has not run since it started (every 2 min).
            </li>
          </ul>
        </TabSection>
        {/* Still editable: the file is what the editor writes, and an app
            whose container is down is exactly when a wrong secret is being
            fixed. Only the LISTING of the live environment needs a snapshot. */}
        <OperatorSecrets app={app} keys={secrets} />
      </>
    )
  }

  const of = (o: EnvRowData['origin']) => env.vars.filter((v) => v.origin === o)
  const platform = of('platform')
  const groups = ENV_GROUP_ORDER.map((g) => ({
    g,
    vars: platform.filter((v) => v.group === g),
  })).filter((x) => x.vars.length > 0)
  const yours = [...of('registry'), ...of('secrets')]

  return (
    <>
      <TabSection
        first
        title="Provided by daedalus"
        label="Provided by daedalus"
        note="Injected at container start, not hot-reloaded. A change takes effect on the next deploy or Apply."
        aside={
          env.takenAt ? (
            <span>
              read from the container <When at={env.takenAt} />
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
        <ul className={ENV_TABLE} aria-label="Provided by daedalus">
          <EnvHead />
          {groups.map(({ g, vars }) => (
            <EnvGroupRows
              key={g}
              title={GROUP_LABELS[g].title}
              note={`${String(vars.length)}${GROUP_LABELS[g].hint ? ` · ${GROUP_LABELS[g].hint}` : ''}`}
              vars={vars}
              app={app}
            />
          ))}
        </ul>
      </TabSection>

      <EnvSection
        title="Yours"
        vars={yours}
        app={app}
        origins
        empty={
          hasSecretsFile
            ? `Nothing beyond what the platform injects. Add values to the registry (they round-trip through Apply) or to ${app}-env.sops.`
            : `Nothing beyond what the platform injects. Add plain values to the registry, or add the first secret below.`
        }
        legend={
          <>
            Declared in <code>apps.json</code>, so they round-trip through Apply, or read from{' '}
            <code>{app}-env.sops</code>. This is what the CONTAINER has; the table below is the
            file, which is where a secret is added, replaced or removed.
          </>
        }
      />

      <OperatorSecrets app={app} keys={secrets} />

      <EnvSection
        title="From the image"
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
    </>
  )
}

function EnvHead({ origins = false }: { origins?: boolean }) {
  return (
    <li className={cn(origins ? ORIGIN_ROW : ENV_ROW, TABLE_HEAD)}>
      <span>Name</span>
      <span className="@max-[44rem]/table:hidden">Value</span>
      {origins && <span>Source</span>}
    </li>
  )
}

function EnvGroupRows({
  title,
  note,
  vars,
  app,
}: {
  title: string
  note: string
  vars: EnvRowData[]
  app: string
}) {
  return (
    <>
      <TableGroup title={title} note={note} />
      {vars.map((v) => (
        <EnvRow key={v.key} app={app} v={v} />
      ))}
    </>
  )
}

function EnvSection({
  title,
  vars,
  app,
  legend,
  empty,
  origins = false,
}: {
  title: string
  vars: EnvRowData[]
  app: string
  legend: ReactNode
  empty: string
  origins?: boolean
}) {
  return (
    <TabSection title={title} label={title}>
      {/* The empty copy already explains where these would come from, so
          showing the legend too says the same thing twice. */}
      {vars.length > 0 && <p className={ENV_LEGEND}>{legend}</p>}
      <ul className={ENV_TABLE} aria-label={title}>
        {vars.length === 0 ? (
          <li className={TABLE_EMPTY}>{empty}</li>
        ) : (
          <>
            <EnvHead origins={origins} />
            {vars.map((v) => (
              <EnvRow key={v.key} app={app} v={v} origin={origins} />
            ))}
          </>
        )}
      </ul>
    </TabSection>
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
function EnvRow({ app, v, origin = false }: { app: string; v: EnvRowData; origin?: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const { run, busy, error } = useAction()

  const shown = v.secret ? revealed : v.value

  return (
    <li className={cn(origin ? ORIGIN_ROW : ENV_ROW, TABLE_ROW, 'min-h-[2.75rem]')}>
      <code className={KEY}>{v.key}</code>
      <div className="min-w-0 @max-[44rem]/table:col-start-1 @max-[44rem]/table:row-start-2">
        <div className="flex min-w-0 items-center gap-2">
          {shown === null ? (
            // Never break: dots carry no information, so wrapping them just
            // makes a column of them.
            <code className="font-mono text-[0.78rem] tracking-[0.12em] whitespace-nowrap text-muted-foreground">
              ••••••••••••
            </code>
          ) : (
            <code className="min-w-0 font-mono text-[0.78rem] text-subdued [overflow-wrap:anywhere]">
              {shown === '' ? <span className="text-muted-foreground">(empty)</span> : shown}
            </code>
          )}

          {v.secret && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="size-6 flex-none p-0 text-muted-foreground disabled:pointer-events-auto disabled:cursor-wait [&_svg]:size-3.5"
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
              {revealed === null ? <EyeIcon /> : <EyeOffIcon />}
            </Button>
          )}
        </div>
        {error !== null && <p className="mt-1 mb-0 text-[0.78rem] text-danger">{error}</p>}
        {v.note && <p className={cn(CELL_SUB, 'mt-0.5 whitespace-normal')}>{v.note}</p>}
      </div>
      {origin && (
        // Two origins share this table; the plain one (registry) is the
        // exception worth ink, the sealed file is the quiet norm.
        <span
          className={cn(
            'text-[0.75rem]',
            v.origin === 'registry' ? 'text-foreground' : 'text-muted-foreground',
            '@max-[44rem]/table:col-start-2 @max-[44rem]/table:row-start-1',
          )}
        >
          {v.origin}
        </span>
      )}
    </li>
  )
}
