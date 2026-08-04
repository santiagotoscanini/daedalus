import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { AreaChart, Bytes, Metric, Panel, Row, Segmented, StatePill, Toggle } from '../components/ui'
import type { DeployStatus } from '../lib/deploy'
import { fetchApp, fetchDeployStatus, saveApp, triggerDeploy } from '../server/registry'

const TABS = ['overview', 'settings', 'logs'] as const

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
    const data = await fetchApp({ data: { name: params.name, withLogs: deps.tab === 'logs' } })
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

type Tab = 'overview' | 'settings' | 'logs'

function AppDetail() {
  const { app, drift, status, dbSize, logs, logs1h, applyStatus, deployStatus, lastDeploy, pullBroken } =
    Route.useLoaderData()
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
            <a href={`https://${app.name}.toscanini.me`} target="_blank" rel="noreferrer">
              ↗ {app.name}.toscanini.me
            </a>
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
            options={[
              { value: 'lab', label: 'Internal', icon: '⛨' },
              { value: 'live', label: 'External', icon: '↗' },
            ]}
          />
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

            <Metric label="Health" value={fmtBool(status?.healthy)}>
              <p className="metric-note">
                gatus probes <code>{app.authHealthPath ?? '/'}</code> from outside every 60s.
              </p>
            </Metric>

            <Metric label="Logs / hour" value={logs1h === null ? '—' : logs1h.toLocaleString()}>
              <p className="metric-note">Lines shipped to Loki in the last hour.</p>
            </Metric>
          </div>

          {/* Deliberately not CPU/memory. Rootless podman puts container
              cgroups under user@1000.service, invisible to the node exporter —
              those series do not exist on this box, so any number here would
              be invented. See src/lib/metrics.ts. */}
          <p className="footnote">
            No per-container CPU or memory: rootless podman hides container cgroups from the node
            exporter, so those series do not exist on this box. Liveness comes from{' '}
            <code>container_up</code> and throughput from traefik.
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

          <Panel title="Environment">
            {app.envVars.length === 0 ?
              <p className="panel-empty">No static environment variables.</p>
            : <table className="env">
                <tbody>
                  {app.envVars.map((e) => (
                    <tr key={e.key}>
                      <th>
                        <code>{e.key}</code>
                      </th>
                      <td>
                        <code>{e.value}</code>
                        {e.note && <p className="note">{e.note}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            }
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
            <p className="panel-empty">Nothing in Loki for the last 6 hours.</p>
          ) : (
            <div className="logs">
              {logs.map((l, i) => (
                <div key={`${l.ts}-${String(i)}`} className={`log log-${l.level ?? 'none'}`}>
                  <time>{l.ts.slice(11, 23)}</time>
                  <span className="lvl">{l.level ?? ''}</span>
                  <span className="msg">{l.line}</span>
                </div>
              ))}
            </div>
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
  disabled,
  onSave,
}: {
  label: string
  value: string
  placeholder?: string
  disabled?: boolean
  onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={() => {
          if (draft !== value) onSave(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </label>
  )
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return v ? 'yes' : 'no'
}
