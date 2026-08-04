import { Await, createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
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
import { BarList } from '../components/viz'
import { BlockSkeleton, MetricsSkeleton, PanelsSkeleton } from '../components/skeleton'
// ./access-window, NOT ./access — same split as env-groups below. The window
// table is a value the picker and validateSearch both need in the browser;
// ./access talks to Loki and must never follow it there.
import {
  ACCESS_WINDOWS,
  DEFAULT_WINDOW,
  WINDOW_SPEC,
  isAccessWindow,
  type AccessWindow,
} from '../lib/access-window'
import type { DeployStatus } from '../lib/deploy'
// ./env-groups, NOT ./env-snapshot: this is client code, and env-snapshot
// imports node:fs/promises. Vite externalises node builtins for the browser,
// so importing a VALUE from that module — even a lookup table — makes the
// page throw on load. Type-only imports would be erased and safe; GROUP_LABELS
// is not.
import { GROUP_LABELS, type EnvGroup, type EnvOrigin } from '../lib/env-groups'
import { BASE_DOMAIN, hostnameError } from '../lib/hostname'
import {
  fetchApp,
  fetchAppTab,
  fetchDeployStatus,
  revealEnvVar,
  saveApp,
  triggerDeploy,
  type AppTabData,
} from '../server/registry'

// Every tab this route can render. Two of them are conditional — `database`
// only exists for an app with postgres, `vpn` only for one with an egress
// container — but they stay in this list because it is what validateSearch
// checks. A URL naming a tab the app does not have renders an explanation of
// how to turn the feature on, which is strictly more useful than silently
// bouncing to the overview.
const TABS = [
  'overview',
  'deployments',
  'database',
  'vpn',
  'access',
  'settings',
  'secrets',
  'logs',
] as const

export const Route = createFileRoute('/apps/$name')({
  // The tab lives in the URL, not in component state: it survives a refresh,
  // it is linkable ("look at ipcrawl's settings"), and it renders on the
  // server, so the settings form is not a client-only surface.
  //
  // `range` is optional rather than defaulted here on purpose: an always-present
  // value would put `?range=7d` in every URL on the site, including the links
  // from the apps list that have nothing to do with the access tab.
  validateSearch: (search: Record<string, unknown>): AppSearch => {
    const tab = TABS.includes(search.tab as Tab) ? (search.tab as Tab) : 'overview'
    return isAccessWindow(search.range) ? { tab, range: search.range } : { tab }
  },
  // The loader depends on the tab, so switching tabs refetches — that is what
  // lets the logs stay off the wire until the logs tab is actually open.
  loaderDeps: ({ search }) => ({ tab: search.tab, range: search.range ?? DEFAULT_WINDOW }),
  // The frame is awaited (it is a Postgres read, and a missing app has to be a
  // real 404 rather than a page that renders and then apologises). The tab's
  // own fan-out is NOT: it is returned as a promise and streamed in behind a
  // skeleton, so opening `access` — ten Loki queries — puts the hero, the tab
  // bar and the app's identity on screen immediately and fills the body in
  // when it arrives.
  loader: async ({ params, deps }) => {
    const shell = await fetchApp({ data: { name: params.name } })
    if (!shell) throw notFound()
    return {
      ...shell,
      tabData: fetchAppTab({
        data: { name: params.name, tab: deps.tab, accessWindow: deps.range },
      }),
    }
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
type AppSearch = { tab: Tab; range?: AccessWindow }

function AppDetail() {
  const {
    app,
    drift,
    status,
    applyStatus,
    deployStatus,
    lastDeploy,
    pullBroken,
    takenHostnames,
    tabData,
  } = Route.useLoaderData()
  const router = useRouter()
  const { tab, range } = Route.useSearch()

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
        {/* The two feature tabs are hidden rather than disabled when the
            feature is off: a greyed-out "vpn" on an app with no egress is a
            question the page has already answered. */}
        {TABS.filter(
          (t) =>
            (t !== 'database' || app.postgres) && (t !== 'vpn' || app.egressContainer !== null),
        ).map((t) => (
          <Link
            key={t}
            to="/apps/$name"
            params={{ name: app.name }}
            // Carry the rest of the search forward, so switching to another tab
            // and back does not silently reset the access window.
            search={(prev) => ({ ...prev, tab: t })}
            className={t === tab ? 'active' : ''}
            replace
          >
            {t}
          </Link>
        ))}
      </nav>

      {tab === 'overview' && (
        <Await
          promise={tabData}
          fallback={
            <>
              <MetricsSkeleton count={6} />
              <PanelsSkeleton count={3} />
            </>
          }
        >
          {(d) =>
            d.kind !== 'overview' ? null : (
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
              value={d.resources.cpu.used === null ? '—' : d.resources.cpu.used.toFixed(2)}
              unit={
                d.resources.cpu.limit === null ?
                  'cores'
                : `/ ${String(d.resources.cpu.limit)} cores`
              }
            >
              <Meter value={d.resources.cpu.used} max={d.resources.cpu.limit} tone="cpu" />
              <AreaChart values={d.resources.cpu.spark} state={state} />
            </Metric>

            <Metric
              label="Memory"
              value={d.resources.memory.used === null ? '—' : fmtMb(d.resources.memory.used)}
              unit={
                d.resources.memory.limit === null ?
                  'MB'
                : `/ ${fmtMb(d.resources.memory.limit)} MB`
              }
            >
              <Meter value={d.resources.memory.used} max={d.resources.memory.limit} tone="mem" />
              <AreaChart values={d.resources.memory.spark} state={state} />
            </Metric>

            <Metric label="Health" value={fmtBool(status?.healthy)}>
              <p className="metric-note">
                gatus probes <code>{app.authHealthPath ?? '/'}</code> from outside every 60s.
              </p>
            </Metric>

            <Metric
              label="Processes"
              value={d.resources.pids.used === null ? '—' : String(d.resources.pids.used)}
              unit={d.resources.pids.limit === null ? '' : `/ ${String(d.resources.pids.limit)}`}
            >
              <Meter value={d.resources.pids.used} max={d.resources.pids.limit} tone="pids" />
              <p className="metric-note">
                {d.resources.oomKills !== null && d.resources.oomKills > 0 ?
                  <span className="bad-text">
                    {d.resources.oomKills} OOM kill{d.resources.oomKills === 1 ? '' : 's'} — the memory
                    cap is too tight.
                  </span>
                : 'Processes and threads. No OOM kills.'}
              </p>
            </Metric>

            <Metric label="Logs / hour" value={d.logs1h === null ? '—' : d.logs1h.toLocaleString()}>
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
                  <Row k="size" v={<Bytes value={d.dbSize} />} />
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
            )
          }
        </Await>
      )}

      {tab === 'deployments' && (
        <Await promise={tabData} fallback={<BlockSkeleton h={420} />}>
          {(td) =>
            td.kind !== 'deployments' ? null : (
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

          {app.sourceMode !== 'local' && (
            <Runners name={app.name} ci={td.ci} activity={td.activity} />
          )}

          {td.deployments.length === 0 ? (
            <p className="lede">
              {app.sourceMode === 'local'
                ? 'Local-source apps have no deploy history — the running code is the working tree.'
                : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
            </p>
          ) : (
            <ol className="timeline">
              {td.deployments.map((d) => (
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
            )
          }
        </Await>
      )}

      {tab === 'database' && (
        <Await
          promise={tabData}
          fallback={
            <>
              <MetricsSkeleton count={4} />
              <PanelsSkeleton count={3} />
            </>
          }
        >
          {(td) => (td.kind !== 'database' ? null : <Database app={app} data={td.database} />)}
        </Await>
      )}

      {tab === 'vpn' && (
        <Await
          promise={tabData}
          fallback={
            <>
              <MetricsSkeleton count={4} />
              <PanelsSkeleton count={2} />
            </>
          }
        >
          {(td) => (td.kind !== 'vpn' ? null : <Vpn app={app} data={td.vpn} />)}
        </Await>
      )}

      {tab === 'access' && (
        <Await
          promise={tabData}
          fallback={
            <>
              <MetricsSkeleton count={4} />
              <BlockSkeleton h={300} />
            </>
          }
        >
          {(td) =>
            td.kind !== 'access' ? null : (
              <Access
                name={app.name}
                hostname={app.effectiveHostname}
                stage={app.stage}
                access={td.access}
                range={range ?? DEFAULT_WINDOW}
              />
            )
          }
        </Await>
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

      {tab === 'secrets' && (
        <Await promise={tabData} fallback={<BlockSkeleton h={400} />}>
          {(td) =>
            td.kind !== 'secrets' ? null : (
              <Secrets app={app.name} env={td.env} hasSecretsFile={app.operatorSecrets} />
            )
          }
        </Await>
      )}

      {tab === 'logs' && (
        <Await promise={tabData} fallback={<BlockSkeleton h={420} />}>
          {(td) =>
            td.kind !== 'logs' ? null : <LogsPanel app={app.name} logs={td.logs} />
          }
        </Await>
      )}

      <ApplyBar
        changed={readOnly || drift.length === 0 ? [] : [{ name: app.name, fields: drift }]}
        initialStatus={applyStatus}
      />
    </>
  )
}

function LogsPanel({ app, logs }: { app: string; logs: { ts: string; level: string | null; line: string }[] }) {
  return (
        <Panel
          title="Recent logs"
          action={
            <a
              className="btn btn-ghost"
              href={`https://grafana.toscanini.me/a/grafana-lokiexplore-app/explore/service/${app}/logs?from=now-15m&to=now&var-ds=loki-default`}
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
  )
}

type LoaderData = Awaited<ReturnType<typeof fetchApp>>
type AppRecord = NonNullable<LoaderData>['app']

type AccessData = Extract<AppTabData, { kind: 'access' }>['access']

/**
 * The app's database on the shared cluster.
 *
 * Read entirely from postgres_exporter, and that is a boundary rather than a
 * shortcut: each app's role can reach its own database and nothing else, so
 * daedalus — which holds credentials for `daedalus` — genuinely cannot connect
 * to anything here. The exporter runs inside the cluster and publishes
 * per-database counters for all of them.
 *
 * So this page shows size, traffic and pressure, and never schema. A table
 * list would mean handing the control plane a connection to every app's data,
 * which is a real boundary traded for a nicer panel.
 */
function Database({ app, data }: { app: AppRecord; data: Extract<AppTabData, { kind: 'database' }>['database'] }) {
  if (!app.postgres) {
    return (
      <p className="lede">
        This app has no database. Turning on Postgres in Settings creates a role and a database on
        the shared cluster and injects <code>DATABASE_URL</code>; nothing else changes.
      </p>
    )
  }

  return (
    <>
      <div className="metrics">
        <Metric label="Size on disk" value={<Bytes value={data.sizeBytes} />}>
          <AreaChart values={data.sizeTrend} state="running" />
          <p className="metric-note">30 days. Includes indexes and dead-tuple bloat.</p>
        </Metric>

        <Metric
          label="Connections"
          value={data.connections === null ? '—' : String(data.connections)}
          unit={data.maxConnections === null ? '' : `/ ${String(data.maxConnections)} cluster-wide`}
        >
          <Meter value={data.connections} max={data.maxConnections} tone="cpu" />
          <p className="metric-note">
            {/* -1 is postgres's own encoding for "no per-database cap", which
                is the state every app here is in. */}
            {data.connectionLimit === null || data.connectionLimit < 0 ?
              'No per-database cap — the cluster ceiling is the only limit.'
            : `Capped at ${String(data.connectionLimit)} for this database.`}
          </p>
        </Metric>

        <Metric
          label="Cache hit"
          value={data.cacheHitPct === null ? '—' : data.cacheHitPct.toFixed(1)}
          unit="%"
        >
          <Meter value={data.cacheHitPct} max={100} tone="mem" />
          <p className="metric-note">
            {/* An idle database reads nothing, so there is no ratio to report
                — which is a different statement from "0% of reads were cached". */}
            {data.cacheHitPct === null ?
              'No block reads in the last 10 minutes.'
            : 'Blocks served from shared buffers rather than disk.'}
          </p>
        </Metric>

        <Metric
          label="Transactions"
          value={data.commitsPerSec === null ? '—' : data.commitsPerSec.toFixed(2)}
          unit="/s"
        >
          <p className="metric-note">
            {data.rollbackPct === null ?
              'Nothing committing or rolling back.'
            : data.rollbackPct > 5 ?
              <span className="bad-text">
                {data.rollbackPct.toFixed(1)}% rolled back — the app is erroring, not the database.
              </span>
            : `${data.rollbackPct.toFixed(1)}% rolled back.`}
          </p>
        </Metric>
      </div>

      <div className="panels">
        <Panel title="Connection">
          <Row k="cluster" v="shared pg (stacks/app-db)" />
          <Row k="database" v={app.name} mono />
          <Row k="role" v={app.name} mono />
          <Row k="host" v="pg:5432" mono />
          <Row k="injected as" v="DATABASE_URL + POSTGRES_*" mono />
          <p className="panel-note">
            The password is machine-generated on the box and never enters git. Rotate it by deleting{' '}
            <code>stacks/app-db/secrets/{app.name}/env</code> and rebuilding.
          </p>
        </Panel>

        <Panel title="Rows per second">
          <Row k="fetched" v={fmtRate(data.tuples.fetched)} />
          <Row k="inserted" v={fmtRate(data.tuples.inserted)} />
          <Row k="updated" v={fmtRate(data.tuples.updated)} />
          <Row k="deleted" v={fmtRate(data.tuples.deleted)} />
          <p className="panel-note">10-minute average, from the cluster’s own counters.</p>
        </Panel>

        <Panel title="Pressure">
          <Row
            k="deadlocks"
            v={
              data.deadlocks !== null && data.deadlocks > 0 ?
                <span className="bad-text">{data.deadlocks} lifetime</span>
              : fmtNumOrDash(data.deadlocks)
            }
          />
          <Row k="temp files written" v={<Bytes value={data.tempBytes} />} />
          <Row
            k="rollback share"
            v={data.rollbackPct === null ? '—' : `${data.rollbackPct.toFixed(2)}%`}
          />
          <p className="panel-note">
            Temp bytes mean queries spilled past <code>work_mem</code> and sorted on disk. Both
            counters are cumulative since the last cluster restart.
          </p>
        </Panel>
      </div>

      <h2>Against the rest of the cluster</h2>
      <BarList
        items={data.cluster.map((c) => ({
          label: c.label,
          value: c.value,
          display: fmtBytes(c.value),
          tone: c.label === app.name ? ('accent' as const) : ('muted' as const),
        }))}
        empty="no databases reporting"
      />

      <p className="footnote">
        Everything here comes from <code>postgres_exporter</code> on the shared cluster. There is no
        table list or query log because daedalus has no connection to this database — its own role
        can only reach <code>daedalus</code>, and that separation is worth more than the panel would
        be.
      </p>
    </>
  )
}

/**
 * The VPN this app's traffic exits through.
 *
 * An egress app has no network stack of its own: it borrows a gluetun
 * container's namespace outright, which is why gluetun publishes the app's
 * host port and why the app cannot be reached any other way. Everything below
 * therefore describes that gluetun instance, scraped under a prometheus job
 * named after the container.
 */
function Vpn({ app, data }: { app: AppRecord; data: Extract<AppTabData, { kind: 'vpn' }>['vpn'] }) {
  if (app.egressContainer === null) {
    return (
      <p className="lede">
        This app’s traffic leaves the house directly. Egress is set in Nix rather than here — it
        pairs a gluetun container with a host port, and both move together.
      </p>
    )
  }

  return (
    <>
      <div className="metrics">
        <Metric
          label="Tunnel"
          value={data.up === null ? 'unknown' : data.up ? 'connected' : 'down'}
        >
          <AreaChart values={data.history} state={data.up === true ? 'running' : 'stopped'} />
          <p className="metric-note">
            {data.uptime24h === null ?
              'No history for this instance yet.'
            : `Up ${data.uptime24h.toFixed(2)}% of the last 24 hours.`}
          </p>
        </Metric>

        <Metric label="Exit" value={data.country ?? '—'}>
          <p className="metric-note">{data.city ?? 'No location reported.'}</p>
        </Metric>

        <Metric label="Public IP" value={data.ip ?? '—'}>
          <p className="metric-note">
            What every request from this app appears to come from. Not this house’s address.
          </p>
        </Metric>

        <Metric
          label="Forwarded port"
          value={data.forwardedPort === null ? '—' : String(data.forwardedPort)}
        >
          <p className="metric-note">
            {/* Only ProtonVPN's port-forwarding instances get one, and the TV
                stack is the only thing here that needs inbound. */}
            {data.forwardedPort === null ?
              'None — this instance does not request one, and nothing needs inbound.'
            : 'Inbound reaches the app on this port at the exit.'}
          </p>
        </Metric>
      </div>

      <div className="panels">
        <Panel title="Namespace">
          <Row k="netns owner" v={app.egressContainer} mono />
          <Row k="host port" v={String(app.egressHostPort)} mono />
          <Row k="scrape job" v={app.egressContainer} mono />
          <p className="panel-note">
            The app runs with <code>--network=container:{app.egressContainer}</code>, so it has no
            interfaces of its own. Only the namespace owner may publish a port, which is why the
            app’s host port is declared on gluetun.
          </p>
        </Panel>

        <Panel title="What this protects">
          <Row k="all outbound" v="through the tunnel" />
          <Row k="kill switch" v="gluetun drops traffic when the tunnel is down" />
          <Row k="DNS" v="resolved inside the namespace" />
          <p className="panel-note">
            If the tunnel drops, the app loses the network rather than falling back to the house
            connection — that is the point of borrowing the namespace instead of routing.
          </p>
        </Panel>
      </div>

      <p className="footnote">
        Read from the gluetun exporter’s prometheus job rather than from gluetun’s control API, so
        it works the same for every instance and needs no per-app port table.
      </p>
    </>
  )
}

function fmtRate(v: number | null): string {
  return v === null ? '—' : v < 1 ? v.toFixed(2) : v.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

function fmtNumOrDash(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('en-US')
}

function fmtBytes(v: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = v
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u] ?? 'B'}`
}

/**
 * Who is reaching this app from the internet.
 *
 * Only the Cloudflare tunnel can answer that. The edge forwards
 * Cf-Connecting-Ip and Cf-Ipcountry, traefik keeps exactly those two headers,
 * and Loki has the access log — so an app published through the tunnel has a
 * real client identity per request. A LAN request has none: rootlessport
 * rewrites the source address on the way in, and every device in the house
 * arrives as the same bridge IP.
 *
 * So this is not "no data yet" for an internal app, it is "there is no such
 * thing", and the empty state says which.
 */
function Access({
  name,
  hostname,
  stage,
  access,
  range,
}: {
  name: string
  hostname: string
  stage: string
  access: AccessData
  range: AccessWindow
}) {
  if (stage !== 'live') {
    return (
      <Panel title="Access patterns" wide>
        <p className="panel-empty">
          {name} is {stage === 'off' ? 'not exposed' : 'internal'}, so there are no remote clients to
          break down.
        </p>
        <p className="panel-note">
          Client IP and country come from the headers Cloudflare adds at the edge, which only exist
          on requests that arrive through the tunnel. LAN requests reach traefik through
          rootlessport, which replaces the source address — every phone, laptop and WireGuard peer
          in the house shows up as the same bridge IP. Set exposure to{' '}
          <strong>External</strong> above to start collecting this.
        </p>
      </Panel>
    )
  }

  const spec = WINDOW_SPEC[range]
  const okRate = access.total > 0 ? ((access.total - access.rejected) / access.total) * 100 : null
  const picker = (
    <nav className="range">
      {ACCESS_WINDOWS.map((w) => (
        <Link
          key={w}
          to="/apps/$name"
          params={{ name }}
          search={(prev) => ({ ...prev, tab: 'access' as const, range: w })}
          className={w === range ? 'active' : ''}
          replace
        >
          {WINDOW_SPEC[w].label}
        </Link>
      ))}
    </nav>
  )

  if (!access.available) {
    return (
      <Panel title="Access patterns" action={picker} wide>
        <p className="panel-empty">Loki did not answer. The access log is the only source here.</p>
      </Panel>
    )
  }

  return (
    <div className="access">
      <div className="access-head">
        <p className="lede">
          Remote requests to <code>{hostname}</code> over {spec.prose}, from traefik&rsquo;s access
          log.
        </p>
        {picker}
      </div>

      {access.truncated && (
        <div className="banner banner-info">
          More requests than one query can return. The totals below are exact; the breakdowns
          describe the most recent {access.sampled.toLocaleString()}.
        </div>
      )}

      <div className="metrics">
        <Metric label="Remote requests" value={access.total.toLocaleString()}>
          <AreaChart values={access.series} state={access.total > 0 ? 'running' : 'unknown'} />
        </Metric>
        <Metric label="Unique clients" value={access.clients.toLocaleString()} unit="IPs" />
        <Metric label="Countries" value={access.countries.toLocaleString()} />
        <Metric
          label="Rejected"
          value={access.rejected.toLocaleString()}
          unit={okRate === null ? undefined : `${okRate.toFixed(0)}% ok`}
        />
      </div>

      {access.total === 0 ? (
        <Panel title="Where from" wide>
          <p className="panel-empty">
            Nothing arrived through the tunnel in {spec.prose}. The route exists — this app is just
            not being visited from outside.
          </p>
        </Panel>
      ) : (
        <>
          <GeoPanel hostname={hostname} range={range} />

          <div className="settings">
              <Panel title="Countries">
              <Bars
                rows={access.byCountry.map((c) => ({
                  key: c.code,
                  label: (
                    <>
                      {c.flag && (
                        <span className="flag" aria-hidden="true">
                          {c.flag}
                        </span>
                      )}
                      {c.name}
                    </>
                  ),
                  count: c.count,
                }))}
                total={access.total}
                tone="geo"
              />
            </Panel>
  
            <Panel title="Top clients">
              <Bars
                rows={access.byClient.map((c) => ({
                  key: c.ip,
                  label: (
                    <>
                      <code>{c.ip}</code>
                      {c.flag && (
                        <span className="flag" aria-hidden="true">
                          {c.flag}
                        </span>
                      )}
                    </>
                  ),
                  count: c.count,
                }))}
                total={access.total}
                tone="client"
              />
            </Panel>
  
            <Panel title="Top paths">
              <Bars
                rows={access.byPath.map((p) => ({
                  key: `${p.path}-${p.status}`,
                  label: (
                    <>
                      <span className={`status status-${p.status.slice(0, 1)}`}>{p.status}</span>
                      <code title={p.path}>{p.path}</code>
                    </>
                  ),
                  count: p.count,
                }))}
                total={access.total}
                tone="path"
              />
            </Panel>
  
            <Panel title="Top user agents">
              <Bars
                rows={access.byAgent.map((a) => ({
                  key: a.key,
                  label: <span title={a.key}>{shortAgent(a.key)}</span>,
                  count: a.count,
                }))}
                total={access.total}
                tone="agent"
              />
            </Panel>
          </div>
        </>
      )}

      {access.recentRejects.length > 0 && (
        <Panel
          title="Recent rejected requests"
          wide
          action={
              <a
                className="btn btn-ghost"
                href={`https://grafana.toscanini.me/d/s2-security/security?from=now-${range}&to=now`}
                target="_blank"
                rel="noreferrer"
              >
                ↗ Grafana
              </a>
            }
          >
            <p className="panel-note">
              4xx and 5xx from the tunnel. Most of this is background noise — the internet scans
              every public hostname for WordPress paths within hours of the DNS record appearing,
              and a 404 is the correct answer. What is worth reading is a <em>succeeding</em>{' '}
              request to somewhere unexpected, not these.
            </p>
            <div className="hits">
              {access.recentRejects.map((r, i) => (
                <div key={`${r.ts}-${String(i)}`} className="hit">
                  <time>{fmtLogTime(r.ts)}</time>
                  <span className={`status status-${r.status.slice(0, 1)}`}>{r.status}</span>
                  <span className="hit-path" title={`${r.method} ${r.path}`}>
                    <span className="hit-method">{r.method}</span> {r.path}
                  </span>
                  <span className="hit-who" title={r.agent}>
                    {r.flag && <span aria-hidden="true">{r.flag}</span>}
                    <code>{r.ip}</code>
                  </span>
                </div>
              ))}
            </div>
        </Panel>
      )}

      <p className="footnote">
        Only tunnel traffic is counted. Loki keeps 30 days, so that is the longest window there is.
        The map is a Grafana panel from the App access dashboard, filtered to this host; the link on
        the rejected-requests panel opens the fleet-wide Security dashboard instead.
      </p>
    </div>
  )
}

/**
 * The Security dashboard's geomap, pinned to one host.
 *
 * A real Grafana panel in an iframe rather than a map rebuilt here. Grafana
 * already owns the projection, the basemap and the ISO-code gazetteer that
 * turns `Cf-Ipcountry` into a coordinate, and none of that is worth a second
 * implementation. `stacks/monitoring/assets/dashboards/System/app-access.json`
 * carries a `$host` variable for exactly this; the same dashboard opened
 * without one is the fleet-wide view.
 *
 * Two things had to be true for this to work, and both live in
 * stacks/monitoring: grafana no longer sends `X-Frame-Options: deny`
 * (GF_SECURITY_ALLOW_EMBEDDING), and the narrower `frame-ancestors` CSP that
 * replaced it names daedalus. daedalus and grafana are both under
 * toscanini.me, so they are same-site and grafana's session cookie rides along
 * with the frame load — no second sign-in, no anonymous access.
 *
 * The caveat is that first load. Grafana auto-logs-in through Pocket ID, and
 * the IdP refuses to be framed, so with no live grafana session the frame
 * comes back empty. A cross-origin frame cannot be inspected for that, so
 * there is no detecting it and swapping in a message — hence the standing
 * link below rather than a conditional one.
 */
function GeoPanel({ hostname, range }: { hostname: string; range: AccessWindow }) {
  const src =
    `https://grafana.toscanini.me/d-solo/s2-app-access/app-access` +
    `?panelId=1&var-host=${encodeURIComponent(hostname)}` +
    `&from=now-${range}&to=now&theme=dark`

  return (
    <Panel
      title="Where from"
      wide
      action={
        <a
          className="btn btn-ghost"
          href={`https://grafana.toscanini.me/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
          target="_blank"
          rel="noreferrer"
        >
          ↗ Grafana
        </a>
      }
    >
      <iframe className="geopanel" src={src} title={`Remote requests to ${hostname} by country`} />
      <p className="footnote">
        Rendered by Grafana. A blank map means this browser has no Grafana session yet — open it{' '}
        <a href="https://grafana.toscanini.me" target="_blank" rel="noreferrer">
          once
        </a>{' '}
        and it will fill in.
      </p>
    </Panel>
  )
}

/** A ranked list with a proportion bar. The ranking is the information. */
function Bars({
  rows,
  total,
  tone,
}: {
  rows: { key: string; label: ReactNode; count: number }[]
  total: number
  tone: string
}) {
  if (rows.length === 0) return <p className="panel-empty">Nothing recorded.</p>
  // Scaled against the top row, not the grand total: with one dominant source
  // every other bar would round to an invisible sliver, and the point of the
  // bar is to compare the rows to each other.
  const top = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className={`bars bars-${tone}`}>
      {rows.map((r) => (
        <div key={r.key} className="bar">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span style={{ width: `${String(Math.max(2, (r.count / top) * 100))}%` }} />
          </span>
          <span className="bar-count">
            {r.count.toLocaleString()}
            {total > 0 && <small>{((r.count / total) * 100).toFixed(0)}%</small>}
          </span>
        </div>
      ))}
    </div>
  )
}

const BROWSER_NAME: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' }
const OS_NAME: Record<string, string> = {
  'Windows NT': 'Windows',
  Macintosh: 'macOS',
  CrOS: 'ChromeOS',
}

/** Browser/bot out of a user-agent string. The full text is in the title. */
function shortAgent(ua: string): string {
  if (ua === '' || ua === '-') return 'none'

  // Crawlers name themselves — Googlebot, GPTBot, bingbot, SemrushBot. Capture
  // the whole token, not the substring "bot", so three different crawlers do
  // not collapse into three identical rows.
  const bot = /([A-Za-z][A-Za-z0-9_.-]*(?:bot|crawler|spider))/i.exec(ua)
  if (bot) return bot[1] ?? 'bot'
  const tool = /^(curl|Wget|python-requests|Go-http-client|okhttp)/i.exec(ua)
  if (tool) return tool[1] ?? ''

  // Edge and Opera both carry a Chrome token as well, and it comes first — so
  // they have to be matched before it or every Edge visit reads as Chrome.
  const branded = /(Firefox|Edg|OPR)\/([0-9]+)/.exec(ua) ?? /(Chrome)\/([0-9]+)/.exec(ua)
  // Safari/604 is the WebKit build, not the browser version; Safari puts its
  // own in Version/.
  const safari = /Version\/([0-9]+)[^)]*Safari\//.exec(ua)

  let label: string
  if (branded) label = `${BROWSER_NAME[branded[1] ?? ''] ?? branded[1] ?? ''} ${branded[2] ?? ''}`
  else if (safari) label = `Safari ${safari[1] ?? ''}`
  else return ua.slice(0, 48)

  const os = /(Windows NT|Macintosh|iPhone|iPad|Android|Linux|CrOS)/.exec(ua)?.[1]
  return os === undefined ? label : `${label} · ${OS_NAME[os] ?? os}`
}

type CiData = Extract<AppTabData, { kind: 'deployments' }>['ci']
type ActivityData = Extract<AppTabData, { kind: 'deployments' }>['activity']

/**
 * The self-hosted runner for this app, and what it is doing.
 *
 * One runner per app and it is EPHEMERAL — it takes a single job, de-registers
 * and a fresh container replaces it. So the runner name changes every build,
 * and a brief "offline" between two jobs is the design working, not a fault.
 * That is why this says "waiting for work" rather than colouring idle red.
 *
 * The page re-fetches while a job is in flight. The underlying snapshot is
 * rewritten every 30s by gha-ci-snapshot, so polling faster than that would
 * only re-read the same file.
 */
function Runners({ name, ci, activity }: { name: string; ci: CiData; activity: ActivityData }) {
  const router = useRouter()
  const job = ci.activeJobs[0] ?? null
  const busy = job !== null || ci.runners.some((r) => r.busy)

  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => {
      void router.invalidate()
    }, 15_000)
    return () => {
      clearInterval(t)
    }
  }, [busy, router])

  return (
    <Panel
      title="Actions runners"
      wide
      action={
        <a
          className="btn btn-ghost"
          href={`https://github.com/santiagotoscanini/${name}/actions`}
          target="_blank"
          rel="noreferrer"
        >
          ↗ GitHub
        </a>
      }
    >
      {!ci.available ? (
        <p className="panel-empty">
          No CI snapshot yet — <code>gha-ci-snapshot</code> has not run since boot (every 30s).
        </p>
      ) : !ci.ok ? (
        <p className="panel-note bad-text">
          Could not reach the GitHub API on the last sweep. This is the snapshot from{' '}
          {ci.takenAt ? fmtWhen(ci.takenAt) : 'an earlier run'} — not a statement about the runners.
        </p>
      ) : (
        <>
          <div className="runners">
            {ci.runners.length === 0 ? (
              <p className="panel-empty">
                No runner registered right now. Ephemeral runners de-register between jobs, so this
                is normal for a few seconds after a build finishes.
              </p>
            ) : (
              ci.runners.map((r) => (
                <div key={r.name} className={`runner runner-${r.busy ? 'busy' : r.status}`}>
                  <div className="runner-head">
                    <code>{r.name}</code>
                    <span className={`chip ${r.busy ? 'chip-warn' : r.status === 'online' ? 'chip-live' : 'chip-off'}`}>
                      {r.busy ? 'busy' : r.status === 'online' ? 'idle' : 'offline'}
                    </span>
                  </div>
                  <div className="runner-labels">
                    {r.labels.map((l) => (
                      <span key={l} className="chip chip-muted">
                        {l}
                      </span>
                    ))}
                  </div>
                  {job && job.runnerName === r.name && <JobProgress job={job} />}
                </div>
              ))
            )}
          </div>

          {job && !ci.runners.some((r) => r.name === job.runnerName) && <JobProgress job={job} />}

          {!busy && (
            <p className="panel-note">
              Waiting for work. Each runner takes one job, then a fresh container replaces it — so
              the name above changes on every build.
            </p>
          )}
        </>
      )}

      <h4 className="runners-sub">Build &amp; deploy activity</h4>
      {activity.length === 0 ? (
        <p className="panel-empty">Nothing in the last 6 hours.</p>
      ) : (
        <div className="logs logs-activity">
          {activity.map((l, i) => (
            <div key={`${l.ts}-${String(i)}`} className={`log log-src-${l.source}`}>
              <time>{fmtLogTime(l.ts)}</time>
              <span className="lvl">{l.source}</span>
              <span className="msg">{l.line}</span>
            </div>
          ))}
        </div>
      )}
      <p className="panel-note">
        The deploy half is this box — pull, restart, health-check — straight from the journal. The
        build half is only the runner announcing a job starting and finishing: the Actions runner
        streams step output to GitHub and never writes it to its own stdout, so the full build log
        lives behind the link above, not here.
      </p>
    </Panel>
  )
}

/** Which step of the job is executing, and how far along it is. */
function JobProgress({ job }: { job: NonNullable<CiData['activeJobs'][number]> }) {
  const total = job.steps.length
  const done = job.steps.filter((s) => s.status === 'completed').length
  const running = job.steps.find((s) => s.status === 'in_progress')
  const pct = total > 0 ? (done / total) * 100 : 0

  return (
    <div className="job">
      <div className="job-head">
        <span className="job-name">⚙ {job.name}</span>
        {job.startedAt && <span className="job-elapsed">{fmtElapsed(job.startedAt)}</span>}
      </div>
      <div className="job-step">
        {job.status === 'queued' ? 'queued — no runner has picked it up yet'
        : running ? `step ${String(done + 1)}/${String(total)} · ${running.name}`
        : `${String(done)}/${String(total)} steps`}
      </div>
      {total > 0 && (
        <div className="meter meter-cpu">
          <span style={{ width: `${String(pct)}%` }} />
        </div>
      )}
    </div>
  )
}

/** "1m 12s" since an ISO timestamp. */
function fmtElapsed(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`
}

type EnvData = { available: boolean; takenAt: string | null; vars: EnvRowData[] }

/**
 * Everything the container actually has, grouped by who put it there — which
 * is the same question as who can change it.
 *
 * Read from the running container rather than re-derived from the registry:
 * that is the only place the four sources are already merged, and the point of
 * the page is to answer "what does this process actually see".
 */
function Secrets({
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
      <Panel title="Environment">
        <p className="panel-empty">
          No snapshot yet — the container is not running, or <code>daedalus-env-snapshot</code> has
          not run since it started (every 2 min).
        </p>
      </Panel>
    )
  }

  const of = (o: EnvRowData['origin']) => env.vars.filter((v) => v.origin === o)
  const platform = of('platform')
  const groups = GROUP_ORDER.map((g) => ({
    g,
    vars: platform.filter((v) => v.group === g),
  })).filter((x) => x.vars.length > 0)

  return (
    // A stack, not bare siblings: .panel carries no margin of its own because
    // everywhere else it lives in a grid that supplies the gap.
    <div className="panel-stack">
      <div className="banner banner-info">
        Injected at container start, not hot-reloaded — a change takes effect on the next deploy or
        Apply.
      </div>

      <Panel
        title="Provided by daedalus"
        wide
        action={
          env.takenAt ? (
            <span className="env-age">read from the container {fmtWhen(env.takenAt)}</span>
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
      </Panel>

      <EnvSection
        title="Yours"
        wide
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
        wide
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
    </div>
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
  vars,
  app,
  legend,
  empty,
  wide,
}: {
  title: string
  vars: EnvRowData[]
  app: string
  legend: ReactNode
  empty: string
  wide?: boolean
}) {
  return (
    <Panel title={title} wide={wide}>
      {/* The empty copy already explains where these would come from, so
          showing the legend too says the same thing twice. */}
      {vars.length === 0 ? (
        <p className="panel-empty">{empty}</p>
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
    </Panel>
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
