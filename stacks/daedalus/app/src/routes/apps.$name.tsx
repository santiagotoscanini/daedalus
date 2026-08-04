import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { ApplyBar } from '../components/apply-bar'
import {
  AreaChart,
  Bytes,
  Meter,
  Metric,
  Panel,
  Row,
  Segmented,
  Slider,
  StatePill,
  Toggle,
} from '../components/ui'
import type { DeployStatus } from '../lib/deploy'
import { BASE_DOMAIN, hostnameError } from '../lib/hostname'
import {
  fetchApp,
  fetchDeployStatus,
  revealEnvVar,
  saveApp,
  triggerDeploy,
} from '../server/registry'

const TABS = ['overview', 'deployments', 'settings', 'logs'] as const

export const Route = createFileRoute('/apps/$name')({
  // The tab lives in the URL, not in component state: it survives a refresh,
  // it is linkable ("look at ipcrawl's settings"), and it renders on the
  // server, so the settings form is not a client-only surface.
  validateSearch: (search: Record<string, unknown>): { tab: Tab } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : 'overview',
  }),
  // The loader depends on the tab, so switching tabs refetches — that is what
  // lets the logs stay off the wire until the logs tab is actually open.
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: async ({ params, deps }) => {
    const data = await fetchApp({
      data: {
        name: params.name,
        // Both are only fetched for the tab that shows them. Loader data is
        // serialised into the HTML for hydration, so pulling logs and deploy
        // history on every tab would pay for them four times over.
        withLogs: deps.tab === 'logs',
        withDeploys: deps.tab === 'deployments',
        withEnv: deps.tab === 'settings',
        withResources: deps.tab === 'overview',
      },
    })
    if (!data) throw notFound()
    return data
  },
  component: AppDetail,
  notFoundComponent: () => (
    <>
      <p className="crumbs">
        <Link to="/apps">Apps</Link>
      </p>
      <h1>Not found</h1>
      <p className="lede">No app by that name is in the registry.</p>
    </>
  ),
})

type Tab = (typeof TABS)[number]

function AppDetail() {
  const {
    app,
    drift,
    status,
    dbSize,
    logs,
    logs1h,
    applyStatus,
    deployStatus,
    lastDeploy,
    pullBroken,
    deployments,
    env,
    resources,
    takenHostnames,
  } = Route.useLoaderData()
  const router = useRouter()
  const { tab } = Route.useSearch()

  const readOnly = app.managedInNix
  const state = status?.state ?? 'unknown'

  // `notes` is jsonb, so the database can hand back anything — an array, a
  // nested object, a number. Rendering an unexpected value throws
  // "Objects are not valid as a React child" and takes down the WHOLE page,
  // which is precisely the page you would use to fix the bad record. Coerce
  // to string pairs and keep going; a mangled note shows as text, not a 500.
  const notes: [string, string][] = Object.entries(
    (app.notes ?? {}) as Record<string, unknown>,
  ).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])

  // Edits go straight to Postgres — the database IS the working copy, and the
  // drift banner is what marks it as not-yet-applied. There is no separate
  // client-side draft to lose on a refresh.
  const patch = (p: Record<string, unknown>) => {
    void saveApp({ data: { name: app.name, patch: p } }).then(() => router.invalidate())
  }

  return (
    <>
      <p className="crumbs">
        <Link to="/apps">Apps</Link> <span>›</span> {app.name}
      </p>

      <section className="hero">
        <div className="hero-icon" data-state={state} aria-hidden="true">
          {state === 'running' ? '✓' : state === 'attention' ? '!' : '○'}
        </div>

        <div className="hero-main">
          <h1>
            {app.name}
            <StatePill state={state} />
            {readOnly && <span className="chip chip-muted">nix-managed</span>}
          </h1>
          <p className="lede">{app.description || 'No description.'}</p>
          <p className="hero-links">
            {app.stage === 'off' ? (
              <span className="muted">⏻ not exposed</span>
            ) : (
              <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
                ↗ {app.effectiveHostname}
              </a>
            )}
            {app.sourceMode === 'local' ? (
              <span className="muted">⎇ stacks/{app.name}/app</span>
            ) : (
              <a
                href={`https://github.com/santiagotoscanini/${app.name}`}
                target="_blank"
                rel="noreferrer"
              >
                ⎇ santiagotoscanini/{app.name}
              </a>
            )}
          </p>
        </div>

        <div className="hero-exposure">
          <span className="hero-exposure-label">exposure</span>
          <Segmented
            value={app.stage}
            disabled={readOnly}
            onChange={(v) => {
              patch({ stage: v })
            }}
            // Three rungs, each adding to the last. "Off" removes the ingress
            // entirely — no traefik router, no DNS, no probe — but does NOT
            // stop the container; it keeps running and keeps deploying.
            options={[
              {
                value: 'off',
                label: 'Off',
                icon: '⏻',
                // The forward-auth middleware is generated FROM the ingress,
                // so an app gated that way has nothing left to gate once the
                // ingress is gone. The platform asserts this; catching it here
                // turns a failed Apply into an explanation.
                disabled: app.authMode === 'proxy',
                reason:
                  app.authMode === 'proxy'
                    ? 'Auth is enforced at the ingress (proxy mode), so this app cannot be unexposed while it relies on that gate.'
                    : undefined,
              },
              { value: 'lab', label: 'Internal', icon: '⛨' },
              { value: 'live', label: 'External', icon: '↗' },
            ]}
          />
          {app.stage === 'off' && (
            <p className="exposure-note">
              No route, DNS or probe. The container still runs.
            </p>
          )}
        </div>
      </section>

      {readOnly && (
        <div className="banner banner-muted">
          Declared by hand in <code>stacks/daedalus/daedalus.nix</code>, so it is read-only here. An
          Apply that broke this entry would take down the interface you would use to undo it.
        </div>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <Link
            key={t}
            to="/apps/$name"
            params={{ name: app.name }}
            search={{ tab: t }}
            className={t === tab ? 'active' : ''}
            replace
          >
            {t}
            {t === 'logs' && logs.length > 0 && <span className="tab-dot" />}
          </Link>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <div className="metrics">
            <Metric
              label="Requests / min"
              value={status?.rpm === null || !status ? '—' : status.rpm.toFixed(1)}
              unit="rpm"
            >
              <AreaChart values={status?.spark ?? []} state={state} />
            </Metric>

            <Metric
              label="CPU"
              value={resources.cpu.used === null ? '—' : resources.cpu.used.toFixed(2)}
              unit={
                resources.cpu.limit === null ?
                  'cores'
                : `/ ${String(resources.cpu.limit)} cores`
              }
            >
              <Meter value={resources.cpu.used} max={resources.cpu.limit} tone="cpu" />
              <AreaChart values={resources.cpu.spark} state={state} />
            </Metric>

            <Metric
              label="Memory"
              value={resources.memory.used === null ? '—' : fmtMb(resources.memory.used)}
              unit={
                resources.memory.limit === null ?
                  'MB'
                : `/ ${fmtMb(resources.memory.limit)} MB`
              }
            >
              <Meter value={resources.memory.used} max={resources.memory.limit} tone="mem" />
              <AreaChart values={resources.memory.spark} state={state} />
            </Metric>

            <Metric label="Health" value={fmtBool(status?.healthy)}>
              <p className="metric-note">
                gatus probes <code>{app.authHealthPath ?? '/'}</code> from outside every 60s.
              </p>
            </Metric>

            <Metric
              label="Processes"
              value={resources.pids.used === null ? '—' : String(resources.pids.used)}
              unit={resources.pids.limit === null ? '' : `/ ${String(resources.pids.limit)}`}
            >
              <Meter value={resources.pids.used} max={resources.pids.limit} tone="pids" />
              <p className="metric-note">
                {resources.oomKills !== null && resources.oomKills > 0 ?
                  <span className="bad-text">
                    {resources.oomKills} OOM kill{resources.oomKills === 1 ? '' : 's'} — the memory
                    cap is too tight.
                  </span>
                : 'Processes and threads. No OOM kills.'}
              </p>
            </Metric>

            <Metric label="Logs / hour" value={logs1h === null ? '—' : logs1h.toLocaleString()}>
              <p className="metric-note">Lines shipped to Loki in the last hour.</p>
            </Metric>
          </div>

          <p className="footnote">
            CPU and memory are read from cgroup v2 by the textfile exporter in{' '}
            <code>stacks/monitoring</code>, at 60-second resolution — cadvisor cannot see rootless
            containers. Memory is <code>memory.current</code>, which counts page cache, so an app
            doing file I/O sits at its limit and is fine; the signal that a cap is too tight is the
            OOM counter moving.
          </p>

          <div className="panels">
            <Panel
              title="Deployment"
              action={
                app.sourceMode === 'local' ? null : (
                  <RedeployButton name={app.name} initial={deployStatus} />
                )
              }
            >
              <Row k="source" v={app.sourceMode === 'local' ? 'local (hot reload)' : 'registry'} />
              <Row k="image" v={app.effectiveImage} mono />
              <Row
                k="auto-deploy"
                v={app.sourceMode === 'local' ? 'n/a — source is live' : 'polls every 2 min'}
              />
              {lastDeploy && (
                <>
                  <Row k="running digest" v={lastDeploy.digest.replace('sha256:', '').slice(0, 12)} mono />
                  <Row
                    k="last deploy"
                    v={
                      <span className={lastDeploy.result === 'ok' ? 'ok-text' : 'bad-text'}>
                        {lastDeploy.result}
                      </span>
                    }
                  />
                </>
              )}
              {pullBroken && (
                <Row k="pulls" v={<span className="bad-text">failing — check the registry token</span>} />
              )}
              <Row k="container" v={`app-${app.name}`} mono />
              <Row k="liveness" v={fmtBool(status?.containerUp)} />
            </Panel>

            <Panel title="Database">
              {app.postgres ? (
                <>
                  <Row k="cluster" v="shared pg" />
                  <Row k="database" v={app.name} mono />
                  <Row k="size" v={<Bytes value={dbSize} />} />
                  <Row k="host" v="pg:5432" mono />
                </>
              ) : (
                <p className="panel-empty">No database. Enable Postgres in Settings.</p>
              )}
            </Panel>

            <Panel title="Access">
              <Row k="auth" v={app.authMode} />
              <Row k="health path" v={app.authHealthPath ?? '—'} mono />
              <Row k="isolated" v={app.authIsolated ? 'yes' : 'no'} />
              <Row k="groups" v={app.authAllowedGroups?.join(', ') ?? 'admins'} />
              <Row k="secrets" v={app.operatorSecrets ? `${app.name}-env.sops` : 'none'} mono />
            </Panel>

            {app.egressContainer && (
              <Panel title="Egress">
                <Row k="netns" v={app.egressContainer} mono />
                <Row k="host port" v={String(app.egressHostPort)} mono />
                <Row k="note" v="all outbound rides the VPN" />
              </Panel>
            )}
          </div>

          {notes.length > 0 && (
            <>
              <h2>Why it is configured this way</h2>
              <dl className="notes">
                {notes.map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </>
      )}

      {tab === 'deployments' && (
        <>
          <p className="deploy-meta">
            {app.sourceMode === 'local' ? (
              <>
                <span className="muted">⎇ stacks/{app.name}/app</span>
                <span className="muted">source is live — nothing to deploy</span>
              </>
            ) : (
              <>
                <a
                  href={`https://github.com/santiagotoscanini/${app.name}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ⎇ santiagotoscanini/{app.name}
                </a>
                <span className="muted">builds run on self-hosted runners</span>
                <a
                  href={`https://github.com/santiagotoscanini/${app.name}/actions`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost deploy-actions"
                >
                  ↗ GitHub Actions
                </a>
              </>
            )}
          </p>

          {deployments.length === 0 ? (
            <p className="lede">
              {app.sourceMode === 'local'
                ? 'Local-source apps have no deploy history — the running code is the working tree.'
                : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
            </p>
          ) : (
            <ol className="timeline">
              {deployments.map((d) => (
                <li key={d.id} className={d.isCurrent ? 'current' : d.result}>
                  <span className={`node node-${d.isCurrent ? 'current' : d.result}`} />
                  <div className={d.isCurrent ? 'deploy-card is-current' : 'deploy-card'}>
                    <div className="deploy-head">
                      <code className="deploy-rev">{d.shortRevision ?? d.digest.slice(0, 12)}</code>
                      {d.commitUrl ? (
                        <a href={d.commitUrl} target="_blank" rel="noreferrer">
                          view commit
                        </a>
                      ) : (
                        <span className="muted">
                          {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                        </span>
                      )}
                      <span
                        className={
                          d.isCurrent ? 'chip chip-warn'
                          : d.result === 'ok' ? 'chip chip-live'
                          : 'chip chip-bad'
                        }
                      >
                        {d.isCurrent ? 'current' : d.result === 'ok' ? 'success' : 'failed'}
                      </span>
                    </div>
                    <div className="deploy-sub">
                      <span>{fmtWhen(d.startedAt)}</span>
                      <span>{fmtDuration(d.durationMs)}</span>
                      <code>{d.digest.slice(0, 12)}</code>
                      {d.httpCode && <span>HTTP {d.httpCode}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {tab === 'settings' && (
        <div className="settings">
          <Panel title="Platform">
            <Toggle
              checked={app.postgres}
              disabled={readOnly}
              onChange={(v) => {
                patch({ postgres: v })
              }}
              label="Postgres"
              hint="Role + database on the shared cluster. Turning it off leaves the database in place."
            />
            <Toggle
              checked={app.storage}
              disabled={readOnly}
              onChange={(v) => {
                patch({ storage: v })
              }}
              label="Persistent storage"
              hint="Bind-mounts a data dir at /app/data."
            />
            <Toggle
              checked={app.litellm}
              disabled={readOnly}
              onChange={(v) => {
                patch({ litellm: v })
              }}
              label="LiteLLM gateway"
              hint="Injects LITELLM_BASE_URL. Does not hand over the master key."
            />
            <Toggle
              checked={app.prometheus}
              disabled={readOnly}
              onChange={(v) => {
                patch({ prometheus: v })
              }}
              label="Prometheus scrape"
              hint="Only turn on once the app actually serves /metrics — otherwise it is a permanently-down target."
            />
          </Panel>

          <Panel title="Routing">
            <TextField
              label="Hostname"
              value={app.hostname ?? ''}
              placeholder={`${app.name}.${BASE_DOMAIN}`}
              disabled={readOnly}
              validate={(v) => hostnameError(v, takenHostnames)}
              hint={
                <>
                  Empty uses the default. Must be one level under{' '}
                  <code>{BASE_DOMAIN}</code> — that is the only domain here with a wildcard
                  certificate, a Cloudflare tunnel and DNS.
                </>
              }
              onSave={(v) => {
                patch({ hostname: v.trim() === '' ? null : v.trim().toLowerCase() })
              }}
            />
            <Row k="published at" v={app.effectiveHostname} mono />
            <p className="panel-note">
              Renaming moves the traefik router, the pi-hole record, the gatus probe, the
              Cloudflare route and <code>AUTH_URL</code>. The container, the database, the sops
              file and the GitHub repo stay keyed by <code>{app.name}</code>. An SSO app cannot
              complete a login for the moment between the rebuild and Pocket ID picking up the new
              redirect URI.
            </p>
          </Panel>

          <Panel title="Resource limits" wide>
            <Slider
              label="CPU"
              hint="cores the container may burn"
              value={app.limitCpus}
              min={0.25}
              max={8}
              step={0.25}
              disabled={readOnly}
              format={(v) => (
                <>
                  {v} <small>{v === 1 ? 'core' : 'cores'}</small>
                </>
              )}
              onChange={(v) => {
                patch({ limitCpus: v })
              }}
            />
            <Slider
              label="Memory"
              hint="resident cap — pages spill to zram past it, OOM kill at twice it"
              value={app.limitMemoryMb}
              min={128}
              max={4096}
              step={128}
              disabled={readOnly}
              format={(v) => (
                <>
                  {v} <small>MB</small>
                </>
              )}
              onChange={(v) => {
                patch({ limitMemoryMb: v })
              }}
            />
            <Slider
              label="Processes"
              hint="max processes + threads (fork-bomb guard)"
              value={app.limitPids}
              min={64}
              max={2048}
              step={64}
              disabled={readOnly}
              format={(v) => v}
              onChange={(v) => {
                patch({ limitPids: v })
              }}
            />
            <p className="panel-note">
              Enforced by cgroup v2, and only because systemd delegates{' '}
              <code>cpu io memory pids</code> down to <code>user@1000.service</code> — without that
              podman would accept the flags and the kernel would ignore them. CPU throttles rather
              than kills. Memory is the resident cap: pages past it spill to zram and the OOM kill
              lands at twice it, because podman writes <code>--memory-swap</code> through verbatim
              instead of subtracting. Threads count toward the process limit, so read the Overview
              before choosing one. Takes effect on the next Apply, which restarts the container.
            </p>
          </Panel>

          <Panel title="Presentation">
            <TextField
              label="Description"
              value={app.description}
              disabled={readOnly}
              onSave={(v) => {
                patch({ homepageDescription: v })
              }}
            />
            <TextField
              label="Icon"
              value={app.icon}
              disabled={readOnly}
              onSave={(v) => {
                patch({ homepageIcon: v })
              }}
            />
            <TextField
              label="Image override"
              value={app.image ?? ''}
              placeholder={`registry.toscanini.me/${app.name}:latest`}
              disabled={readOnly || app.sourceMode === 'local'}
              onSave={(v) => {
                patch({ image: v.trim() === '' ? null : v.trim() })
              }}
            />
          </Panel>

          <Panel
            title="Environment"
            // Full width, not a grid cell: a URL or a connection string in a
            // 21rem column wraps character-by-character into a ragged stack.
            wide
            action={
              env.takenAt ? (
                <span className="env-age">read from the container {fmtWhen(env.takenAt)}</span>
              ) : null
            }
          >
            {!env.available ? (
              <p className="panel-empty">
                No snapshot yet — the container is not running, or
                <code> daedalus-env-snapshot</code> has not run since it started (every 2 min).
              </p>
            ) : (
              <>
                <p className="env-legend">
                  Everything the container actually has: what the platform injects, what the
                  registry declares, and what the image bakes in. Secrets are withheld until
                  revealed — they are not in this page&apos;s source.
                </p>
                <div className="env">
                  {env.vars.map((v) => (
                    <EnvRow key={v.key} app={app.name} v={v} />
                  ))}
                </div>
              </>
            )}
          </Panel>

          <Panel title="Not editable here">
            <p className="panel-empty">
              <strong>Auth mode, egress and operator secrets</strong> are read-only for now. Moving
              auth means provisioning an <code>SSO_SECRET_{app.name.toUpperCase()}</code> into
              <code> stacks/pocket-id/clients.sops</code> — writing encrypted state is its own
              design problem, and a half-applied auth change locks you out of the app. Egress needs
              a gluetun instance to exist first; operator secrets need a{' '}
              <code>{app.name}-env.sops</code> authored by hand.
            </p>
          </Panel>
        </div>
      )}

      {tab === 'logs' && (
        <Panel
          title="Recent logs"
          action={
            <a
              className="btn btn-ghost"
              href={`https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${app.name}/logs?from=now-15m&to=now&var-ds=loki-default`}
              target="_blank"
              rel="noreferrer"
            >
              ↗ Grafana
            </a>
          }
        >
          {logs.length === 0 ? (
            <p className="panel-empty">Nothing in Loki for the last 7 days.</p>
          ) : (
            <>
              {isStale(logs[logs.length - 1]?.ts) && (
                <p className="panel-note">
                  Newest line is {fmtWhen(logs[logs.length - 1]?.ts ?? '')} — this app has been
                  quiet since. Not a broken pipeline: several apps here only log at startup.
                </p>
              )}
              <div className="logs">
                {logs.map((l, i) => (
                  <div key={`${l.ts}-${String(i)}`} className={`log log-${l.level ?? 'none'}`}>
                    {/* Date included whenever the line is not from today.
                        Time-of-day alone made three-day-old startup logs read
                        as if they had just happened. */}
                    <time>{fmtLogTime(l.ts)}</time>
                    <span className="lvl">{l.level ?? ''}</span>
                    <span className="msg">{l.line}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Panel>
      )}

      <ApplyBar
        changed={readOnly || drift.length === 0 ? [] : [{ name: app.name, fields: drift }]}
        initialStatus={applyStatus}
      />
    </>
  )
}

type EnvRowData = {
  key: string
  origin: 'registry' | 'platform' | 'image'
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

/**
 * Runs the app's deploy unit now rather than waiting for its 2-minute timer.
 * Same unit either way, so a redeploy that finds an unchanged digest is a
 * no-op — this is not a "restart" button.
 */
function RedeployButton({ name, initial }: { name: string; initial: DeployStatus }) {
  const router = useRouter()
  const [status, setStatus] = useState(initial)
  const [submitting, setSubmitting] = useState(false)
  const running = status.state === 'running' || submitting

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      void fetchDeployStatus().then((s) => {
        setStatus(s)
        if (s.state !== 'running') {
          setSubmitting(false)
          void router.invalidate()
        }
      })
    }, 2000)
    return () => {
      clearInterval(t)
    }
  }, [running, router])

  return (
    <span className="redeploy">
      {status.state === 'failed' && status.app === name && (
        <span className="bad-text" title={status.error}>
          last attempt failed
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={running}
        onClick={() => {
          setSubmitting(true)
          void triggerDeploy({ data: name }).catch(() => {
            setSubmitting(false)
          })
        }}
      >
        {running ? '↻ deploying…' : '↻ Redeploy'}
      </button>
    </span>
  )
}

/** Text input that commits on blur or Enter — no per-keystroke writes. */
function TextField({
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
  const [draft, setDraft] = useState(value)
  const error = validate ? validate(draft) : null

  return (
    <label className={error === null ? 'field' : 'field field-bad'}>
      <span>{label}</span>
      <input
        type="text"
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
      {error !== null ?
        <small className="field-error">{error}</small>
      : hint !== undefined && <small className="field-hint">{hint}</small>}
    </label>
  )
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return v ? 'yes' : 'no'
}

/** Bytes → whole MB. MiB, matching what --memory takes and cgroup enforces. */
function fmtMb(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)).toLocaleString()
}

/** Older than an hour — worth telling the reader before they misread the panel. */
function isStale(iso: string | undefined): boolean {
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() > 60 * 60 * 1000
}

/** "14:22:09.214" for today, "Jul 31 23:22:09" for anything older. */
function fmtLogTime(iso: string): string {
  const d = new Date(iso)
  const sameDay = new Date().toISOString().slice(0, 10) === iso.slice(0, 10)
  return sameDay
    ? iso.slice(11, 23)
    : `${d.toLocaleString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' })} ${iso.slice(11, 19)}`
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`
}

function fmtWhen(iso: string): string {
  const then = new Date(iso)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  const rel =
    mins < 1 ? 'just now'
    : mins < 60 ? `${String(mins)}m ago`
    : mins < 60 * 24 ? `${String(Math.round(mins / 60))}h ago`
    : `${String(Math.round(mins / 1440))}d ago`
  // Absolute first, relative second: "3d ago" alone is useless when you are
  // trying to correlate a deploy with something else that happened.
  return `${then.toISOString().slice(0, 16).replace('T', ' ')} · ${rel}`
}
