import { type ReactNode, useState } from 'react'
// ./env-groups, NOT ./env-snapshot: this is client code, and env-snapshot
// imports node:fs/promises. Vite externalises node builtins for the browser,
// so importing a VALUE from that module — even a lookup table — makes the
// page throw on load. Type-only imports would be erased and safe; GROUP_LABELS
// is not.
import { type EnvGroup, type EnvOrigin, GROUP_LABELS } from '../../lib/env-groups'
import { when } from '../../lib/format'
import { revealEnvVar } from '../../server/registry'
import { Board, BoardGrid } from '../viz'

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
}: {
  app: string
  env: EnvData
  hasSecretsFile: boolean
}) {
  if (!env.available) {
    return (
      <BoardGrid>
        <Board title="Environment" icon="key" span={12}>
          <p className="viz-empty">
            No snapshot yet — the container is not running, or <code>daedalus-env-snapshot</code>{' '}
            has not run since it started (every 2 min).
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
      <div className="banner banner-info">
        Injected at container start, not hot-reloaded — a change takes effect on the next deploy or
        Apply.
      </div>

      <BoardGrid>
        <Board
          title="Provided by daedalus"
          icon="◱"
          span={12}
          aside={
            env.takenAt ? (
              <span className="env-age">read from the container {when(env.takenAt)}</span>
            ) : null
          }
        >
          <p className="env-legend">
            Injected by the apps platform from the toggles on Settings. Read-only here because they
            are not values so much as consequences: turn Postgres off and the whole database block
            goes with it. Secret values are withheld until revealed — they are never in this
            page&apos;s source.
          </p>
          {groups.map(({ g, vars }) => (
            <section key={g} className="env-group">
              <h4>
                <span className="env-group-icon" aria-hidden="true">
                  {GROUP_LABELS[g].icon}
                </span>
                {GROUP_LABELS[g].title}
                <span className="env-group-count">{vars.length}</span>
              </h4>
              {GROUP_LABELS[g].hint && <p className="env-group-hint">{GROUP_LABELS[g].hint}</p>}
              <div className="env">
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
          empty="Nothing — this image bakes in no environment of its own."
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
        <p className="viz-empty">{empty}</p>
      ) : (
        <>
          <p className="env-legend">{legend}</p>
          <div className="env">
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
    <div className="env-row">
      <div className="env-key">
        <code>{v.key}</code>
        <span className={`origin origin-${v.origin}`}>{v.origin}</span>
      </div>
      <div>
        <div className="env-value">
          {shown === null ? (
            <code className="masked">••••••••••••</code>
          ) : (
            <code>{shown === '' ? <span className="muted">(empty)</span> : shown}</code>
          )}

          {v.secret && (
            <button
              type="button"
              className="reveal"
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
            </button>
          )}
        </div>
        {v.note && <p className="note">{v.note}</p>}
      </div>
    </div>
  )
}
