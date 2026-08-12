import { Await, createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { GrafanaLogs } from '../components/logs'
import { BlockSkeleton, BoardsSkeleton, StripSkeleton } from '../components/skeleton'
import { usePolledStatus } from '../components/status'
import { AppIcon, Bytes, Segmented, Slider, StatePill, Toggle } from '../components/ui'
import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Facts,
  Progress,
  Stat,
  StatStrip,
} from '../components/viz'
// ./access-window, NOT ./access — same split as env-groups below. The window
// table is a value the picker and validateSearch both need in the browser;
// ./access talks to Loki and must never follow it there.
import {
  ACCESS_WINDOWS,
  type AccessWindow,
  DEFAULT_WINDOW,
  isAccessWindow,
  WINDOW_SPEC,
} from '../lib/access-window'
import type { CiRequestStatus } from '../lib/ci-request'
import type { DeployStatus } from '../lib/deploy'
// ./env-groups, NOT ./env-snapshot: this is client code, and env-snapshot
// imports node:fs/promises. Vite externalises node builtins for the browser,
// so importing a VALUE from that module — even a lookup table — makes the
// page throw on load. Type-only imports would be erased and safe; GROUP_LABELS
// is not.
import { type EnvGroup, type EnvOrigin, GROUP_LABELS } from '../lib/env-groups'
import { bytes, DASH, logTime, ms, when } from '../lib/format'
import { BASE_DOMAIN, hostnameError } from '../lib/hostname'
import { defaultImage, GRAFANA_URL, OWNER } from '../lib/site'
import {
  type AppTabData,
  deleteAppFn,
  fetchApp,
  fetchAppTab,
  fetchCiRequestStatus,
  fetchDeployStatus,
  revealEnvVar,
  runCiFn,
  saveApp,
  triggerDeploy,
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

/** The auth mode as a person would say it, not as the column stores it. */
const AUTH_WORD: Record<string, string> = {
  none: 'none',
  proxy: 'forward-auth',
  native: 'app is the client',
}

/**
 * An image reference short enough to sit in a value column.
 *
 * The registry host is the same for every app here and the tag is `latest` for
 * almost all of them, so the middle is the only part that identifies anything.
 * The full string stays in the title.
 */
function shortImage(ref: string): string {
  const slash = ref.lastIndexOf('/')
  return slash === -1 ? ref : ref.slice(slash + 1)
}

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
        {/* The app's own icon, in a frame that keeps carrying state. Identity
            and health are different questions and the frame answers the second
            without spending the slot that answers the first. */}
        <div className="hero-icon" data-state={state}>
          <AppIcon name={app.name} hasIcon={app.hasIcon} size={34} />
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
              <a href={`https://github.com/${OWNER}/${app.name}`} target="_blank" rel="noreferrer">
                ⎇ {OWNER}/{app.name}
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
            <p className="exposure-note">No route, DNS or probe. The container still runs.</p>
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
              <BlockSkeleton h={86} />
              <BoardsSkeleton spans={[4, 4, 4]} />
            </>
          }
        >
          {(d) =>
            d.kind !== 'overview' ? null : (
              <>
                {/* Six readings in the order you would ask them: is it up, is anyone
              using it, what is it costing, is it being noisy. */}
                <StatStrip>
                  {/* The probe, not the container state — the hero above already
                carries running/stopped, and a second copy of it here would
                spend a cell of the strip agreeing with itself. */}
                  <Stat
                    label="Health"
                    value={
                      status?.healthy === undefined || status.healthy === null
                        ? 'not probed'
                        : status.healthy
                          ? 'ok'
                          : 'failing'
                    }
                    tone={
                      status?.healthy === undefined || status.healthy === null
                        ? undefined
                        : status.healthy
                          ? 'ok'
                          : 'bad'
                    }
                    sub={status?.containerUp === false ? 'container down' : 'probed every 60s'}
                    title={`gatus probes ${app.authHealthPath ?? '/'} from outside every 60s. Container liveness: ${fmtBool(status?.containerUp)}.`}
                  />
                  <Stat
                    label="Requests"
                    value={status?.rpm === null || !status ? DASH : status.rpm.toFixed(1)}
                    unit="/min"
                    spark={status?.spark ?? []}
                    sub="last hour"
                  />
                  <Stat
                    label="CPU"
                    value={d.resources.cpu.used === null ? DASH : d.resources.cpu.used.toFixed(2)}
                    unit={
                      d.resources.cpu.limit === null
                        ? 'cores'
                        : `of ${String(d.resources.cpu.limit)}`
                    }
                    spark={d.resources.cpu.spark}
                  />
                  <Stat
                    label="Memory"
                    value={d.resources.memory.used === null ? DASH : fmtMb(d.resources.memory.used)}
                    unit={
                      d.resources.memory.limit === null
                        ? 'MB'
                        : `of ${fmtMb(d.resources.memory.limit)}`
                    }
                    spark={d.resources.memory.spark}
                  />
                  <Stat
                    label="Processes"
                    value={d.resources.pids.used === null ? DASH : String(d.resources.pids.used)}
                    unit={
                      d.resources.pids.limit === null ? '' : `of ${String(d.resources.pids.limit)}`
                    }
                    // The OOM counter is the one reading here that can be a fault,
                    // so it is the one allowed to take a colour — and it replaces
                    // the caption rather than sitting beside it, because "no OOM
                    // kills" is not news and "3 OOM kills" is.
                    tone={
                      d.resources.oomKills !== null && d.resources.oomKills > 0 ? 'bad' : undefined
                    }
                    sub={
                      d.resources.oomKills !== null && d.resources.oomKills > 0
                        ? `${String(d.resources.oomKills)} OOM kill${d.resources.oomKills === 1 ? '' : 's'}`
                        : 'no OOM kills'
                    }
                  />
                  <Stat
                    label="Logs"
                    value={d.logs1h === null ? DASH : d.logs1h.toLocaleString('en-US')}
                    unit="/hour"
                    sub="shipped to Loki"
                  />
                </StatStrip>

                <p className="strip-foot">
                  CPU and memory come from cgroup v2 at 60-second resolution — memory is{' '}
                  <code>memory.current</code>, which counts page cache, so an app doing file I/O
                  sits at its limit and is fine. The signal that a cap is too tight is the OOM
                  counter moving.
                </p>

                <BoardGrid>
                  <Board
                    title="Deployment"
                    icon="◲"
                    span={4}
                    aside={
                      app.sourceMode === 'local' ? null : (
                        <RedeployButton name={app.name} initial={deployStatus} />
                      )
                    }
                  >
                    <Facts
                      list
                      rows={[
                        {
                          k: 'source',
                          v: app.sourceMode === 'local' ? 'local (hot reload)' : 'registry',
                        },
                        {
                          k: 'image',
                          v: (
                            <code title={app.effectiveImage}>{shortImage(app.effectiveImage)}</code>
                          ),
                        },
                        {
                          k: 'auto-deploy',
                          v: app.sourceMode === 'local' ? 'n/a — source is live' : 'every 2 min',
                        },
                        ...(lastDeploy
                          ? [
                              {
                                k: 'running digest',
                                v: (
                                  <code>
                                    {lastDeploy.digest.replace('sha256:', '').slice(0, 12)}
                                  </code>
                                ),
                              },
                              {
                                k: 'last deploy',
                                v: (
                                  <span
                                    className={lastDeploy.result === 'ok' ? 'ok-text' : 'bad-text'}
                                  >
                                    {lastDeploy.result}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        ...(pullBroken
                          ? [
                              {
                                k: 'pulls',
                                v: <span className="bad-text">failing — check the registry</span>,
                              },
                            ]
                          : []),
                        { k: 'container', v: <code>app-{app.name}</code> },
                      ]}
                    />
                  </Board>

                  <Board title="Database" icon="◧" span={4}>
                    {app.postgres ? (
                      <Facts
                        list
                        rows={[
                          { k: 'cluster', v: 'shared pg' },
                          { k: 'database', v: <code>{app.name}</code> },
                          { k: 'size', v: <Bytes value={d.dbSize} /> },
                          { k: 'host', v: <code>pg:5432</code> },
                        ]}
                      />
                    ) : (
                      <p className="viz-empty">No database. Enable Postgres in Settings.</p>
                    )}
                  </Board>

                  <Board title="Access" icon="⛨" span={4}>
                    <Facts
                      list
                      rows={[
                        { k: 'auth', v: AUTH_WORD[app.authMode] ?? app.authMode },
                        { k: 'health path', v: <code>{app.authHealthPath ?? DASH}</code> },
                        { k: 'isolated', v: app.authIsolated ? 'yes' : 'no' },
                        { k: 'groups', v: app.authAllowedGroups?.join(', ') ?? 'admins' },
                        {
                          k: 'secrets',
                          v: app.operatorSecrets ? (
                            <code>{app.name}-env.sops</code>
                          ) : (
                            <span className="muted">none</span>
                          ),
                        },
                      ]}
                    />
                  </Board>

                  {app.egressContainer && (
                    <Board title="Egress" icon="⇄" span={4}>
                      <Facts
                        list
                        rows={[
                          { k: 'netns', v: <code>{app.egressContainer}</code> },
                          { k: 'host port', v: <code>{String(app.egressHostPort)}</code> },
                          { k: 'outbound', v: 'all through the VPN' },
                        ]}
                      />
                    </Board>
                  )}

                  {notes.length > 0 && (
                    <Board title="Why it is configured this way" icon="✎" span={12}>
                      <dl className="notes">
                        {notes.map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{v}</dd>
                          </div>
                        ))}
                      </dl>
                    </Board>
                  )}
                </BoardGrid>
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
                        href={`https://github.com/${OWNER}/${app.name}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ⎇ {OWNER}/{app.name}
                      </a>
                      <span className="muted">builds run on self-hosted runners</span>
                      <span className="deploy-actions">
                        <RunCiButton repo={app.name} publish={td.publish} />
                        <a
                          href={`https://github.com/santiagotoscanini/${app.name}/actions`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-ghost"
                        >
                          ↗ GitHub Actions
                        </a>
                      </span>
                    </>
                  )}
                </p>

                {app.sourceMode !== 'local' && <Runners ci={td.ci} activity={td.activity} />}

                {td.deployments.length === 0 ? (
                  <p className="lede">
                    {app.sourceMode === 'local'
                      ? 'Local-source apps have no deploy history — the running code is the working tree.'
                      : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
                  </p>
                ) : (
                  <>
                    <h2 className="section-head">
                      Deploy history
                      <small>only the runs where the digest actually moved</small>
                    </h2>
                    <ol className="timeline">
                      {td.deployments.map((d) => (
                        <li key={d.id} className={d.isCurrent ? 'current' : d.result}>
                          <span className={`node node-${d.isCurrent ? 'current' : d.result}`} />
                          <div className={d.isCurrent ? 'deploy-card is-current' : 'deploy-card'}>
                            <div className="deploy-head">
                              <code className="deploy-rev">
                                {d.shortRevision ?? d.digest.slice(0, 12)}
                              </code>
                              <span
                                className={
                                  d.isCurrent
                                    ? 'chip chip-warn'
                                    : d.result === 'ok'
                                      ? 'chip chip-live'
                                      : 'chip chip-bad'
                                }
                              >
                                {d.isCurrent ? 'current' : d.result === 'ok' ? 'success' : 'failed'}
                              </span>
                              {d.commitUrl ? (
                                <a href={d.commitUrl} target="_blank" rel="noreferrer">
                                  view commit ↗
                                </a>
                              ) : (
                                <span className="muted">
                                  {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                                </span>
                              )}
                            </div>
                            <div className="deploy-sub">
                              <span>{when(d.startedAt)}</span>
                              <span>{ms(d.durationMs)}</span>
                              <code>{d.digest.slice(0, 12)}</code>
                              {d.httpCode && <span>HTTP {d.httpCode}</span>}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
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
              <StripSkeleton count={6} />
              <BoardsSkeleton spans={[4, 4, 4]} />
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
              <StripSkeleton count={4} />
              <BoardsSkeleton spans={[6, 6]} />
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
              <StripSkeleton count={4} />
              <BoardsSkeleton spans={[12, 6, 6]} />
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
        <BoardGrid>
          <Board title="Platform" icon="◱" span={4}>
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
            <Facts
              list
              rows={[
                {
                  k: 'operator secrets',
                  v: app.operatorSecrets ? (
                    <code>{app.name}-env.sops</code>
                  ) : (
                    <span className="muted">none</span>
                  ),
                },
              ]}
            />
            <p className="board-foot">
              Secrets have no switch because the file is the switch: a tracked{' '}
              <code>stacks/apps/{app.name}-env.sops</code> is loaded into the container, and nothing
              else decides it. Author it with <code>sops</code>, <code>git add</code> it, and the
              next rebuild injects it.
            </p>
          </Board>

          <Board title="Routing" icon="⇢" span={4}>
            <TextField
              label="Hostname"
              value={app.hostname ?? ''}
              placeholder={`${app.name}.${BASE_DOMAIN}`}
              disabled={readOnly}
              validate={(v) => hostnameError(v, takenHostnames)}
              hint={
                <>
                  Empty uses the default. Must be one level under <code>{BASE_DOMAIN}</code> — that
                  is the only domain here with a wildcard certificate, a Cloudflare tunnel and DNS.
                </>
              }
              onSave={(v) => {
                patch({ hostname: v.trim() === '' ? null : v.trim().toLowerCase() })
              }}
            />
            <Facts list rows={[{ k: 'published at', v: <code>{app.effectiveHostname}</code> }]} />
            <p className="board-foot">
              Renaming moves the traefik router, the pi-hole record, the gatus probe, the Cloudflare
              route and <code>AUTH_URL</code>. The container, the database, the sops file and the
              GitHub repo stay keyed by <code>{app.name}</code>. An SSO app cannot complete a login
              for the moment between the rebuild and Pocket ID picking up the new redirect URI.
            </p>
          </Board>

          <Board title="Presentation" icon="✦" span={4}>
            <TextField
              label="Description"
              value={app.description}
              disabled={readOnly}
              onSave={(v) => {
                patch({ description: v })
              }}
            />
            {/* No icon field: the app publishes one and daedalus reads it. See
                lib/app-icon.ts — a column here could only ever agree or
                disagree with what the browser tab already shows. */}
            <TextField
              label="Image override"
              value={app.image ?? ''}
              placeholder={defaultImage(app.name)}
              disabled={readOnly || app.sourceMode === 'local'}
              onSave={(v) => {
                patch({ image: v.trim() === '' ? null : v.trim() })
              }}
            />
            {/* Beside the image override on purpose: the two are one workflow.
                A freeze without a pin only stops FUTURE digests — the current
                `:latest` re-resolves on any container recreate — so holding a
                known-good build means both. */}
            <Toggle
              checked={app.deployEnable}
              disabled={readOnly || app.sourceMode === 'local'}
              onChange={(v) => {
                patch({ deployEnable: v })
              }}
              label="Auto-deploy"
              hint="Poll the registry every 2 min and redeploy when the digest moves. Off freezes the app — the timer stops and the Redeploy button is refused host-side. Pair with a digest-pinned image override to hold a known-good build."
            />
          </Board>

          <Board title="Resource limits" icon="◴" span={6}>
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
            <p className="board-foot">
              Enforced by cgroup v2, and only because systemd delegates{' '}
              <code>cpu io memory pids</code> down to <code>user@1000.service</code> — without that
              podman would accept the flags and the kernel would ignore them. CPU throttles rather
              than kills. Memory is the resident cap: pages past it spill to zram and the OOM kill
              lands at twice it, because podman writes <code>--memory-swap</code> through verbatim
              instead of subtracting. Takes effect on the next Apply, which restarts the container.
            </p>
          </Board>

          <Board title="Single sign-on" icon="⚿" span={6}>
            <Segmented
              value={app.authMode}
              disabled={readOnly}
              onChange={(v) => {
                patch({ authMode: v })
              }}
              options={[
                { value: 'none', label: 'None', icon: '○' },
                {
                  value: 'proxy',
                  label: 'Forward-auth',
                  icon: '⛨',
                  // Both are assertions in stacks/apps/apps.nix. Greyed out with
                  // the reason rather than accepted and failed mid-Apply.
                  disabled: app.stage === 'off' || !app.authHealthPath,
                  reason:
                    app.stage === 'off'
                      ? 'Nothing to gate: the middleware is generated from the ingress, and this app is not exposed.'
                      : !app.authHealthPath
                        ? 'Set a health path first — it is the unauthenticated path the gate lets through, so the probe tests the app instead of the login redirect.'
                        : undefined,
                },
                { value: 'native', label: 'App is the client', icon: '⚿' },
              ]}
            />
            <p className="board-foot">
              {app.authMode === 'none'
                ? 'No SSO. Whatever login the app ships is the only one — for an app with its own accounts that means its own password form.'
                : app.authMode === 'proxy'
                  ? 'traefik gates the router; the app never learns there is an IdP. For apps with no user model of their own.'
                  : 'The app is the OIDC client: it gets OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_PROVIDER_ID, OIDC_PROVIDER_NAME and OIDC_SCOPES, plus OIDC_CLIENT_SECRET from a rendered file. For apps with accounts of their own, which is what keeps per-user data isolated.'}
            </p>
            <TextField
              label="Health path"
              value={app.authHealthPath ?? ''}
              placeholder="/api/healthz"
              disabled={readOnly}
              hint="Unauthenticated path the app itself serves. Required for forward-auth; also what gatus probes."
              onSave={(v) => {
                patch({ authHealthPath: v.trim() === '' ? null : v.trim() })
              }}
            />
            <Facts
              list
              rows={[
                { k: 'client id', v: <code>{app.name}</code> },
                {
                  k: 'redirect uri',
                  v: (
                    <code title={`https://${app.effectiveHostname}/api/auth/callback/pocket-id`}>
                      /api/auth/callback/pocket-id
                    </code>
                  ),
                },
              ]}
            />
            <p className="board-foot">
              The client is declared, not clicked: this materializes{' '}
              <code>fleet.ssoClients.{app.name}</code>, and a oneshot creates it at the IdP on the
              next Apply. Its secret is generated on the box the first time the client is declared,
              so there is nothing to author and nothing to paste back. Egress is not editable here
              at all — routing an app through a VPN needs a gluetun instance to exist first, and
              that is a stack of its own.
            </p>
          </Board>

          {!readOnly && (
            <RemovePanel name={app.name} postgres={app.postgres} storage={app.storage} />
          )}
        </BoardGrid>
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

      {/* Grafana renders these. Nothing is fetched for this tab any more —
          the frame does its own querying, so opening it costs one request to
          Grafana rather than a Loki round trip through here AND sixty log
          lines serialised into the page for hydration. */}
      {/* No Panel around it: you are already on the Logs tab, so a box
          captioned "Logs" inside it is a second label for the same thing. */}
      {tab === 'logs' && (
        <GrafanaLogs source={{ container: `app-${app.name}` }} title={`${app.name} logs`} />
      )}

      <ApplyBar
        changed={readOnly || drift.length === 0 ? [] : [{ name: app.name, fields: drift }]}
        initialStatus={applyStatus}
      />
    </>
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
function Database({
  app,
  data,
}: {
  app: AppRecord
  data: Extract<AppTabData, { kind: 'database' }>['database']
}) {
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
      <StatStrip>
        <Stat
          label="Size on disk"
          value={<Bytes value={data.sizeBytes} />}
          spark={data.sizeTrend}
          sub="30 days"
        />
        <Stat
          label="Connections"
          value={data.connections === null ? DASH : String(data.connections)}
          unit={data.maxConnections === null ? '' : `of ${String(data.maxConnections)}`}
          // -1 is postgres's own encoding for "no per-database cap", which is
          // the state every app here is in.
          sub={
            data.connectionLimit === null || data.connectionLimit < 0
              ? 'cluster-wide ceiling'
              : `capped at ${String(data.connectionLimit)}`
          }
        />
        <Stat
          label="Cache hit"
          value={data.cacheHitPct === null ? DASH : data.cacheHitPct.toFixed(1)}
          unit="%"
          // An idle database reads nothing, so there is no ratio to report —
          // a different statement from "0% of reads were cached".
          sub={data.cacheHitPct === null ? 'no reads in 10 min' : 'from shared buffers'}
        />
        <Stat
          label="Transactions"
          value={data.commitsPerSec === null ? DASH : data.commitsPerSec.toFixed(2)}
          unit="/s"
          tone={data.rollbackPct !== null && data.rollbackPct > 5 ? 'bad' : undefined}
          sub={data.rollbackPct === null ? 'idle' : `${data.rollbackPct.toFixed(1)}% rolled back`}
          title={
            data.rollbackPct !== null && data.rollbackPct > 5
              ? 'A high rollback share means the app is erroring, not the database.'
              : undefined
          }
        />
        <Stat
          label="Deadlocks"
          value={data.deadlocks === null ? DASH : data.deadlocks.toLocaleString('en-US')}
          tone={data.deadlocks !== null && data.deadlocks > 0 ? 'bad' : undefined}
          sub="since cluster start"
        />
        <Stat
          label="Temp files"
          value={<Bytes value={data.tempBytes} />}
          sub="spilled past work_mem"
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Connection" icon="◧" span={4}>
          <Facts
            list
            rows={[
              { k: 'cluster', v: 'shared pg' },
              { k: 'database', v: <code>{app.name}</code> },
              { k: 'role', v: <code>{app.name}</code> },
              { k: 'host', v: <code>pg:5432</code> },
              { k: 'injected as', v: <code>DATABASE_URL</code> },
            ]}
          />
          <p className="board-foot">
            The password is machine-generated on the box and never enters git. Rotate it by deleting{' '}
            <code>stacks/app-db/secrets/{app.name}/env</code> and rebuilding.
          </p>
        </Board>

        <Board title="Rows per second" icon="≣" span={4}>
          <Facts
            list
            rows={[
              { k: 'fetched', v: fmtRate(data.tuples.fetched) },
              { k: 'inserted', v: fmtRate(data.tuples.inserted) },
              { k: 'updated', v: fmtRate(data.tuples.updated) },
              { k: 'deleted', v: fmtRate(data.tuples.deleted) },
            ]}
          />
          <p className="board-foot">10-minute average, from the cluster’s own counters.</p>
        </Board>

        <Board title="Against the cluster" icon="▤" span={4}>
          <BarList
            items={data.cluster.map((c) => ({
              label: c.label,
              value: c.value,
              display: bytes(c.value),
              tone: c.label === app.name ? ('accent' as const) : ('muted' as const),
            }))}
            empty="no databases reporting"
          />
          <p className="board-foot">
            Every database on the shared cluster by size, this one highlighted.
          </p>
        </Board>
      </BoardGrid>

      <p className="strip-foot">
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
      <StatStrip>
        <Stat
          label="Tunnel"
          value={data.up === null ? 'unknown' : data.up ? 'connected' : 'down'}
          tone={data.up === null ? 'warn' : data.up ? 'ok' : 'bad'}
          sub={data.uptime24h === null ? 'no history yet' : `${data.uptime24h.toFixed(2)}% of 24h`}
        />
        <Stat label="Exit" value={data.country ?? DASH} sub={data.city ?? 'no location'} />
        <Stat label="Public IP" value={data.ip ?? DASH} sub="what this app appears as" />
        <Stat
          label="Forwarded port"
          value={data.forwardedPort === null ? DASH : String(data.forwardedPort)}
          // Only ProtonVPN's port-forwarding instances get one, and the TV
          // stack is the only thing here that needs inbound.
          sub={data.forwardedPort === null ? 'none requested' : 'inbound reaches the app'}
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Namespace" icon="⇄" span={6}>
          <Facts
            list
            rows={[
              { k: 'netns owner', v: <code>{app.egressContainer}</code> },
              { k: 'host port', v: <code>{String(app.egressHostPort)}</code> },
              { k: 'scrape job', v: <code>{app.egressContainer}</code> },
            ]}
          />
          <p className="board-foot">
            The app runs with <code>--network=container:{app.egressContainer}</code>, so it has no
            interfaces of its own. Only the namespace owner may publish a port, which is why the
            app’s host port is declared on gluetun.
          </p>
        </Board>

        <Board title="What this protects" icon="⛨" span={6}>
          <Facts
            list
            rows={[
              { k: 'all outbound', v: 'through the tunnel' },
              { k: 'kill switch', v: 'traffic drops with the tunnel' },
              { k: 'DNS', v: 'resolved inside the namespace' },
            ]}
          />
          <p className="board-foot">
            If the tunnel drops, the app loses the network rather than falling back to the house
            connection — that is the point of borrowing the namespace instead of routing.
          </p>
        </Board>
      </BoardGrid>

      <p className="strip-foot">
        Read from the gluetun exporter’s prometheus job rather than from gluetun’s control API, so
        it works the same for every instance and needs no per-app port table.
      </p>
    </>
  )
}

function fmtRate(v: number | null): string {
  return v === null
    ? '—'
    : v < 1
      ? v.toFixed(2)
      : v.toLocaleString('en-US', { maximumFractionDigits: 1 })
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
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12}>
          <p className="viz-empty">
            {name} is {stage === 'off' ? 'not exposed' : 'internal'}, so there are no remote clients
            to break down.
          </p>
          <p className="board-foot">
            Client IP and country come from the headers Cloudflare adds at the edge, which only
            exist on requests that arrive through the tunnel. LAN requests reach traefik through
            rootlessport, which replaces the source address — every phone, laptop and WireGuard peer
            in the house shows up as the same bridge IP. Set exposure to <strong>External</strong>{' '}
            above to start collecting this.
          </p>
        </Board>
      </BoardGrid>
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
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12} aside={picker}>
          <p className="viz-empty">Loki did not answer. The access log is the only source here.</p>
        </Board>
      </BoardGrid>
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

      <StatStrip>
        <Stat
          label="Remote requests"
          value={access.total.toLocaleString('en-US')}
          spark={access.series}
          sub={spec.prose}
        />
        <Stat
          label="Unique clients"
          value={access.clients.toLocaleString('en-US')}
          unit="IPs"
          sub="distinct addresses"
        />
        <Stat
          label="Countries"
          value={access.countries.toLocaleString('en-US')}
          sub="by edge header"
        />
        <Stat
          label="Rejected"
          value={access.rejected.toLocaleString('en-US')}
          tone={okRate !== null && okRate < 50 ? 'warn' : undefined}
          sub={okRate === null ? 'nothing to rate' : `${okRate.toFixed(0)}% ok`}
        />
      </StatStrip>

      {access.total === 0 ? (
        <BoardGrid>
          <Board title="Where from" icon="⊕" span={12}>
            <p className="viz-empty">
              Nothing arrived through the tunnel in {spec.prose}. The route exists — this app is
              just not being visited from outside.
            </p>
          </Board>
        </BoardGrid>
      ) : (
        <BoardGrid>
          <GeoPanel hostname={hostname} range={range} />

          <Board title="Countries" icon="⊕" span={6}>
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
          </Board>

          <Board title="Top clients" icon="◉" span={6}>
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
          </Board>

          <Board title="Top paths" icon="⇢" span={6}>
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
          </Board>

          <Board title="Top user agents" icon="◇" span={6}>
            <Bars
              rows={access.byAgent.map((a) => ({
                key: a.key,
                label: <span title={a.key}>{shortAgent(a.key)}</span>,
                count: a.count,
              }))}
              total={access.total}
              tone="agent"
            />
          </Board>

          {access.recentRejects.length > 0 && (
            <Board
              title="Recent rejected requests"
              icon="⊘"
              span={12}
              aside={
                <a
                  className="btn btn-ghost"
                  href={`${GRAFANA_URL}/d/s2-security/security?from=now-${range}&to=now`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↗ Grafana
                </a>
              }
            >
              <div className="hits">
                {access.recentRejects.map((r, i) => (
                  <div key={`${r.ts}-${String(i)}`} className="hit">
                    <time>{logTime(r.ts)}</time>
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
              <p className="board-foot">
                4xx and 5xx from the tunnel. Most of this is background noise — the internet scans
                every public hostname for WordPress paths within hours of the DNS record appearing,
                and a 404 is the correct answer. What is worth reading is a <em>succeeding</em>{' '}
                request to somewhere unexpected, not these.
              </p>
            </Board>
          )}
        </BoardGrid>
      )}

      <p className="strip-foot">
        Only tunnel traffic is counted. Loki keeps 30 days, so that is the longest window there is.
        The map is a Grafana panel from the App access dashboard, filtered to this host; the link on
        the rejected-requests board opens the fleet-wide Security dashboard instead.
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
    `${GRAFANA_URL}/d-solo/s2-app-access/app-access` +
    `?panelId=1&var-host=${encodeURIComponent(hostname)}` +
    `&from=now-${range}&to=now&theme=dark`

  return (
    <Board
      title="Where from"
      icon="🌐"
      span={12}
      aside={
        <a
          className="btn btn-ghost"
          href={`${GRAFANA_URL}/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
          target="_blank"
          rel="noreferrer"
        >
          ↗ Grafana
        </a>
      }
    >
      <iframe className="geopanel" src={src} title={`Remote requests to ${hostname} by country`} />
      <p className="board-foot">
        Rendered by Grafana. A blank map means this browser has no Grafana session yet — open it{' '}
        <a href={GRAFANA_URL} target="_blank" rel="noreferrer">
          once
        </a>{' '}
        and it will fill in.
      </p>
    </Board>
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
  if (rows.length === 0) return <p className="viz-empty">Nothing recorded.</p>
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
 * and a brief absence between two jobs is the design working, not a fault.
 * That is why idle is drawn as the resting state rather than coloured red.
 *
 * The page re-fetches while a job is in flight. The underlying snapshot is
 * rewritten every 30s by gha-ci-snapshot, so polling faster than that would
 * only re-read the same file.
 */
function Runners({ ci, activity }: { ci: CiData; activity: ActivityData }) {
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

  const rolled = rollUp(activity)

  return (
    <BoardGrid>
      <Board
        title="Runner"
        icon="⚙"
        span={4}
        aside={
          busy ? (
            <Chip tone="warn">busy</Chip>
          ) : ci.available && ci.ok ? (
            <Chip tone="muted">idle</Chip>
          ) : null
        }
      >
        {!ci.available ? (
          <p className="viz-empty">
            No CI snapshot yet — <code>gha-ci-snapshot</code> has not run since boot.
          </p>
        ) : !ci.ok ? (
          <p className="viz-empty text-bad">
            Could not reach the GitHub API on the last sweep. This is the snapshot from{' '}
            {ci.takenAt ? when(ci.takenAt) : 'an earlier run'} — not a statement about the runners.
          </p>
        ) : ci.runners.length === 0 ? (
          <p className="viz-empty">
            None registered. Ephemeral runners de-register between jobs, so this is normal for a few
            seconds after a build finishes.
          </p>
        ) : (
          ci.runners.map((r) => (
            <div key={r.name} className={r.busy ? 'runner runner-busy' : 'runner'}>
              <code className="runner-name">{r.name}</code>
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

        {job && !ci.runners.some((r) => r.name === job.runnerName) && <JobProgress job={job} />}

        <p className="board-foot">
          One job per runner, then a fresh container replaces it — so the name changes on every
          build, and a gap between two jobs is the design working.
        </p>
      </Board>

      <Board
        title="Build &amp; deploy activity"
        icon="≡"
        span={8}
        aside={<span className="board-note">last 6 hours</span>}
      >
        {rolled.length === 0 ? (
          <p className="viz-empty">Nothing in the last 6 hours.</p>
        ) : (
          <div className="acts">
            {rolled.map((l) => (
              <div key={l.key} className={`act act-${l.source}`}>
                <time>{logTime(l.ts)}</time>
                <span className="act-src">{l.source}</span>
                <span className="act-msg">{l.line}</span>
                {l.count > 1 && (
                  <span
                    className="act-n"
                    title={`Repeated ${String(l.count)} times, most recently at ${logTime(l.lastTs)}`}
                  >
                    ×{l.count}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="board-foot">
          The deploy half is the journal — pull, restart, health-check. The build half is only the
          runner announcing a job starting and finishing: it streams step output to GitHub and never
          writes it to its own stdout, so the full build log lives behind the link above.
        </p>
      </Board>
    </BoardGrid>
  )
}

type RolledLine = {
  key: string
  ts: string
  lastTs: string
  line: string
  source: 'build' | 'deploy'
  count: number
}

/**
 * Collapse runs of an identical line into one row with a count.
 *
 * The deploy timer fires every two minutes and logs the same "no change"
 * verdict each time, so six hours of a healthy app is 180 identical lines —
 * a wall that reads as activity and buries the three lines that are not.
 * Folding a run into `no change ×180` says the same thing in one row and
 * leaves the real events visible.
 *
 * Runs only, not a global tally: two "no change" blocks either side of a real
 * deploy are two different facts, and merging them across it would put the
 * events out of order.
 */
function rollUp(rows: ActivityData): RolledLine[] {
  const out: RolledLine[] = []
  for (const r of rows) {
    const line = shortenDigests(r.line)
    const last = out[out.length - 1]
    if (last && last.line === line && last.source === r.source) {
      last.count++
      last.lastTs = r.ts
      continue
    }
    out.push({
      key: `${r.ts}-${String(out.length)}`,
      ts: r.ts,
      lastTs: r.ts,
      line,
      source: r.source,
      count: 1,
    })
  }
  return out
}

/**
 * `sha256:c20afeca1270849c…f58` → `c20afeca1270`.
 *
 * A full digest is 71 characters and every one of these lines carries one, so
 * untouched they were the whole row and the message they qualify was pushed off
 * the end. Twelve hex characters is what the rest of the page shows and what
 * anyone comparing two of these actually reads.
 */
function shortenDigests(line: string): string {
  return line.replace(/sha256:([0-9a-f]{12})[0-9a-f]{52}/g, '$1')
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
        {job.status === 'queued'
          ? 'queued — no runner has picked it up yet'
          : running
            ? `step ${String(done + 1)}/${String(total)} · ${running.name}`
            : `${String(done)}/${String(total)} steps`}
      </div>
      {total > 0 && <Progress pct={pct} tone="accent" active={running !== undefined} />}
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
      <BoardGrid>
        <Board title="Environment" icon="⚿" span={12}>
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

/**
 * Runs the app's deploy unit now rather than waiting for its 2-minute timer.
 * Same unit either way, so a redeploy that finds an unchanged digest is a
 * no-op — this is not a "restart" button.
 */
function RedeployButton({ name, initial }: { name: string; initial: DeployStatus }) {
  const router = useRouter()
  const { status, running, start } = usePolledStatus({
    initial,
    fetch: () => fetchDeployStatus(),
    onSettle: () => {
      void router.invalidate()
    },
  })

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
          start(async () => (await triggerDeploy({ data: name })).id)
        }}
      >
        {running ? '↻ deploying…' : '↻ Redeploy'}
      </button>
    </span>
  )
}

/**
 * Build and publish, from here.
 *
 * Dispatches the repo's publishing workflow — the same run a push to the
 * default branch would trigger, on the same self-hosted runner, so its progress
 * shows up in the Actions runners panel below and its image goes through the
 * normal deploy path. It is not a second way to deploy: what it does is put a
 * build on a runner, and everything after that is unchanged.
 *
 * Useful on an app that already exists (rebuild without an empty commit, and
 * watch the job), and load-bearing on one that does not yet — see the create
 * page, where it is the only way to get a first image.
 */
const CI_IDLE: CiRequestStatus = {
  id: null,
  action: null,
  repo: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

function RunCiButton({
  repo,
  publish,
}: {
  repo: string
  publish: { workflow: string | null; dispatchable: boolean }
}) {
  const router = useRouter()
  // A dispatch that never reached the host (the server function threw) —
  // distinct from a request the host took and then failed.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { status, running, start } = usePolledStatus({
    initial: CI_IDLE,
    fetch: () => fetchCiRequestStatus(),
    intervalMs: 1500,
    onSettle: () => {
      void router.invalidate()
    },
  })
  const failed = submitError !== null || status.state === 'failed'
  const message = submitError ?? (status.state === 'failed' ? status.error : status.detail)

  if (publish.workflow === null) {
    return (
      <span className="muted" title="No workflow in this repo pushes to the box's registry.">
        no publishing workflow
      </span>
    )
  }
  if (!publish.dispatchable) {
    return (
      <span
        className="muted"
        title={`${publish.workflow} has no workflow_dispatch trigger, so it can only be started by a push.`}
      >
        {publish.workflow} is not dispatchable
      </span>
    )
  }

  return (
    <span className="redeploy">
      {failed && !running && (
        <span className="bad-text" title={message}>
          dispatch failed
        </span>
      )}
      {status.state === 'done' && <span className="ok-text">dispatched</span>}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={running}
        title={`Dispatch ${publish.workflow}`}
        onClick={() => {
          setSubmitError(null)
          start(async () => {
            try {
              const r = await runCiFn({ data: { repo, workflow: publish.workflow ?? '' } })
              return r.id
            } catch (e: unknown) {
              setSubmitError(e instanceof Error ? e.message : String(e))
              return null
            }
          })
        }}
      >
        {running ? '⚙ dispatching…' : '⚙ Run CI'}
      </button>
    </span>
  )
}

/**
 * Remove the app from the registry.
 *
 * Confirm-by-typing rather than a dialog: the cost of this is not the click,
 * it is that the next Apply takes the app off the box, and typing the name is
 * the cheapest way to make sure the app being removed is the app you are
 * looking at.
 *
 * The honest part is the list of what does NOT go away. `deleteApp` removes a
 * declaration; the postgres database, the data directory and any sops file
 * outlive it, because a UI button should not be able to destroy data that
 * takes a restore to get back. Reclaiming them stays a deliberate act at a
 * shell, and the panel says so instead of leaving you to find out.
 */
function RemovePanel({
  name,
  postgres,
  storage,
}: {
  name: string
  postgres: boolean
  storage: boolean
}) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = () => {
    setBusy(true)
    setError(null)
    void deleteAppFn({ data: { name } })
      .then(() => router.navigate({ to: '/apps' }))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  return (
    <Board title="Remove" icon="⌫" span={12}>
      <div className="danger">
        <div className="danger-text">
          <p>
            Deletes the registry entry. The next Apply removes the container, the traefik router,
            the pi-hole record, the gatus probe, the Cloudflare route and this app’s CI runner.
          </p>
          <p className="board-foot">
            <b>Not removed:</b>{' '}
            {[
              postgres && `the ${name} database and role on the shared cluster`,
              storage && `/home/santiago/selfhost/apps/${name}/data`,
              `stacks/apps/secrets/${name}/`,
              `any stacks/apps/${name}-env.sops`,
              'the GitHub repo and its published images',
            ]
              .filter((s): s is string => typeof s === 'string')
              .join(', ')}
            . Those are data, and removing them is a separate, deliberate act.
          </p>
        </div>
        <div className="danger-act">
          <label className="field">
            <span>Type “{name}” to confirm</span>
            <input
              type="text"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
              }}
            />
          </label>
          {error !== null && <p className="banner">{error}</p>}
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirm !== name || busy}
            onClick={remove}
          >
            {busy ? 'Removing…' : 'Remove from registry'}
          </button>
        </div>
      </div>
    </Board>
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
      {error !== null ? (
        <small className="field-error">{error}</small>
      ) : (
        hint !== undefined && <small className="field-hint">{hint}</small>
      )}
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
