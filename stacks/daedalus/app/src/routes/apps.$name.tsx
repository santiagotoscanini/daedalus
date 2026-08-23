import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { ApplyBar } from '../components/apply-bar'
import { Access } from '../components/apps/access'
import { Database } from '../components/apps/database'
import { Deployments } from '../components/apps/deployments'
import { Overview } from '../components/apps/overview'
import { Secrets } from '../components/apps/secrets'
import { Settings } from '../components/apps/settings'
import { Vpn } from '../components/apps/vpn'
import { GuardedAwait } from '../components/error'
import { GrafanaLogs } from '../components/logs'
import { BlockSkeleton, BoardsSkeleton, StripSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { AppIcon, Segmented, StatePill } from '../components/ui'
// ./access-window, NOT ./access — same split as env-groups below. The window
// table is a value the picker and validateSearch both need in the browser;
// ./access talks to Loki and must never follow it there.
import { type AccessWindow, DEFAULT_WINDOW, isAccessWindow } from '../lib/access-window'
import { OWNER } from '../lib/site'
import { fetchApp, fetchAppTab, saveApp } from '../server/registry'

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
  // it is linkable ("look at argus's settings"), and it renders on the
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
    repo,
    workspace,
    workspaceRoot,
    workspaceStatus,
    tabData,
  } = Route.useLoaderData()
  const router = useRouter()
  const { tab, range } = Route.useSearch()

  const readOnly = app.managedInNix
  const state = status?.state ?? 'unknown'

  // What un-errors a failed tab body: anything that makes the loader hand
  // over a fresh tabData promise. The range is part of it so widening the
  // access window is itself a retry.
  const sectionKey = `${tab}:${range ?? ''}`

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
            // The "exposure" text beside this is a bare span, not a <label>,
            // so the group still needs naming for assistive tech.
            label="Exposure"
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

      {/* The two feature tabs are hidden rather than disabled when the
          feature is off: a greyed-out "vpn" on an app with no egress is a
          question the page has already answered. */}
      <TabBar
        tabs={TABS.filter(
          (t) =>
            (t !== 'database' || app.postgres) && (t !== 'vpn' || app.egressContainer !== null),
        ).map((t) => ({ id: t, label: t }))}
        active={tab}
        linkTo={(t) => ({
          to: '/apps/$name',
          params: { name: app.name },
          // Carry the rest of the search forward, so switching to another tab
          // and back does not silently reset the access window.
          search: (prev) => ({ ...prev, tab: t }),
        })}
      />

      {tab === 'overview' && (
        <GuardedAwait
          resetKey={sectionKey}
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
              <Overview
                app={app}
                status={status}
                deployStatus={deployStatus}
                lastDeploy={lastDeploy}
                pullBroken={pullBroken}
                repo={repo}
                workspace={workspace}
                workspaceRoot={workspaceRoot}
                workspaceStatus={workspaceStatus}
                d={d}
              />
            )
          }
        </GuardedAwait>
      )}

      {tab === 'deployments' && (
        <GuardedAwait resetKey={sectionKey} promise={tabData} fallback={<BlockSkeleton h={420} />}>
          {(td) => (td.kind !== 'deployments' ? null : <Deployments app={app} td={td} />)}
        </GuardedAwait>
      )}

      {tab === 'database' && (
        <GuardedAwait
          resetKey={sectionKey}
          promise={tabData}
          fallback={
            <>
              <StripSkeleton count={6} />
              <BoardsSkeleton spans={[4, 4, 4]} />
            </>
          }
        >
          {(td) => (td.kind !== 'database' ? null : <Database app={app} data={td.database} />)}
        </GuardedAwait>
      )}

      {tab === 'vpn' && (
        <GuardedAwait
          resetKey={sectionKey}
          promise={tabData}
          fallback={
            <>
              <StripSkeleton count={4} />
              <BoardsSkeleton spans={[6, 6]} />
            </>
          }
        >
          {(td) => (td.kind !== 'vpn' ? null : <Vpn app={app} data={td.vpn} />)}
        </GuardedAwait>
      )}

      {tab === 'access' && (
        <GuardedAwait
          resetKey={sectionKey}
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
        </GuardedAwait>
      )}

      {tab === 'settings' && (
        <Settings app={app} readOnly={readOnly} patch={patch} takenHostnames={takenHostnames} />
      )}

      {tab === 'secrets' && (
        <GuardedAwait resetKey={sectionKey} promise={tabData} fallback={<BlockSkeleton h={400} />}>
          {(td) =>
            td.kind !== 'secrets' ? null : (
              <Secrets app={app.name} env={td.env} hasSecretsFile={app.operatorSecrets} />
            )
          }
        </GuardedAwait>
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
