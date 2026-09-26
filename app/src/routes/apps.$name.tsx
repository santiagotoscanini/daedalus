import { createFileRoute, Link, notFound, useRouter } from '@tanstack/react-router'
import { ApplyBar } from '../components/apply-bar'
import { Access } from '../components/apps/access'
import { Database } from '../components/apps/database'
import { Deployments } from '../components/apps/deployments'
import { Overview } from '../components/apps/overview'
import { Secrets } from '../components/apps/secrets'
import { Settings } from '../components/apps/settings'
import { CHIP, LEDE } from '../components/apps/shared'
import { Tasks } from '../components/apps/tasks'
import { Variables } from '../components/apps/variables'
import { Vpn } from '../components/apps/vpn'
import { AppIcon, type AppState, Segmented, StatePill } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { GrafanaLogs } from '../components/logs'
import { Crumbs, PageHead } from '../components/page'
import { BlockSkeleton, BoardsSkeleton, StripSkeleton } from '../components/skeleton'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
// lib/access-window, NOT host/access. The window table is a value the picker
// and validateSearch both need in the browser; host/access talks to Loki and
// must never follow it there.
import { type AccessWindow, DEFAULT_WINDOW, isAccessWindow } from '../lib/access-window'
import { cn } from '../lib/cn'
import { isAppName } from '../lib/hostname'
import { known } from '../lib/known'
import { appRepo } from '../lib/site'
import { useSite } from '../lib/site-context'
import { type Tone, toneStyle } from '../lib/tone'
import { fetchApp, fetchAppTab, saveApp } from '../server/registry'

// Every tab this route can render. Two of them are conditional — `database`
// only exists for an app with postgres and `vpn` only for one with an egress
// container — but they stay in this list because it is what validateSearch
// checks. A URL naming a tab the app does not have renders an explanation of
// how to turn the feature on, which is strictly more useful than silently
// bouncing to the overview. `tasks` is unconditional on purpose (AppRail says
// why). Exported for the shell: when this route is matched, the global rail
// swaps to the app-scoped one (components/shell/app-rail.tsx) and renders
// these as its sections.
export const APP_TABS = [
  'overview',
  'deployments',
  'database',
  'vpn',
  'tasks',
  'access',
  'settings',
  'variables',
  'secrets',
  'logs',
] as const
const TABS = APP_TABS

/* The hero: identity on the left, exposure on the right. Below the rail
   breakpoint exposure becomes a full-width row under the title instead of a
   third column — at that width it was overflowing the card's right edge. */
const HERO =
  'mb-6 grid grid-cols-[auto_1fr_auto] items-start gap-5 rounded-xl border border-(--border-soft) bg-card px-6 py-[1.35rem] max-rail:grid-cols-[auto_minmax(0,1fr)] max-rail:gap-x-4 max-rail:gap-y-[0.9rem] max-rail:p-[1.1rem]'
const HERO_ICON =
  'grid size-[54px] place-items-center rounded-[12px] border bg-(--panel-2) text-[1.4rem] text-(--dim) max-rail:size-[42px] max-rail:text-[1.15rem]'
const HERO_ICON_TONED =
  'border-[color-mix(in_srgb,var(--tone)_30%,transparent)] bg-[color-mix(in_srgb,var(--tone)_8%,transparent)] text-(--tone)'
/** The two states that are verdicts. The rest get the frame's resting grey. */
const ICON_TONE: Partial<Record<AppState, Tone>> = { running: 'ok', attention: 'bad' }
const HERO_LINKS =
  'mt-[0.65rem] mb-0 flex flex-wrap gap-x-[1.1rem] gap-y-[0.4rem] font-mono text-[0.85rem] max-[34rem]:flex-col max-[34rem]:gap-[0.35rem] max-[34rem]:[&>*]:wrap-anywhere'
/* `Segmented` (components/controls.tsx) goes full-width below the rail
   breakpoint when it sits here — it sits alone in its own hero column — and
   the descendant rules are what tell it so, since it cannot know on its own. */
const HERO_EXPOSURE =
  'text-right max-rail:col-span-full max-rail:text-left max-rail:[&_[role=radiogroup]]:flex max-rail:[&_[role=radiogroup]]:w-full max-rail:[&_[role=radio]]:flex-1 max-rail:[&_[role=radio]]:justify-center'

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
  // skeleton, so opening `access` — a Loki scan that takes up to a second —
  // puts the hero, the tab bar and the app's identity on screen immediately
  // and fills the body in when it arrives.
  loader: async ({ params, deps }) => {
    // fetchApp refuses a name that could not be an app's (lib/hostname
    // isAppName). Nothing links here with one, so a URL that carries one was
    // typed, and a typed URL deserves the not-found page below rather than an
    // error boundary over a rejected request.
    if (!isAppName(params.name)) throw notFound()
    // The identity, from this browser's memory past the first visit
    // (lib/known.ts): the tab bar and the hero must not wait a round trip
    // on every tab. The request rate and its spark move on every read and
    // are left out of the comparison; a change of state is not.
    const shell = await known(
      `app/${params.name}`,
      () => fetchApp({ data: { name: params.name } }),
      (s) =>
        JSON.stringify(
          s === null
            ? null
            : {
                ...s,
                status:
                  s.status === null
                    ? null
                    : {
                        state: s.status.state,
                        up: s.status.containerUp,
                        healthy: s.status.healthy,
                      },
              },
        ),
    )
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
      <Crumbs>
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>
      </Crumbs>
      <PageHead title="Not found">No app by that name is in the registry.</PageHead>
    </>
  ),
})

type Tab = (typeof TABS)[number]
type AppSearch = { tab: Tab; range?: AccessWindow }

function AppDetail() {
  const site = useSite()
  const {
    app,
    drift,
    status,
    applyStatus,
    deployStatus,
    lastDeploy,
    pullBroken,
    deployShot,
    takenHostnames,
    repo,
    workspace,
    workspaceRoot,
    workspaceStatus,
    stateRoot,
    tabData,
  } = Route.useLoaderData()
  const router = useRouter()
  const { tab, range } = Route.useSearch()

  const readOnly = app.managedInNix
  const state = status?.state ?? 'unknown'
  const iconTone = ICON_TONE[state]

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

  // The sections, as one switch over the tab rather than as independent
  // `{tab === 'x' && …}` siblings. Siblings, a new entry in APP_TABS renders
  // a blank page and nothing anywhere says so; here it is TS7030 at this
  // function, because the return type is inferred and noImplicitReturns is on.
  // Called inline rather than mounted as a <Section/> so each branch stays a
  // direct child of this component's tree.
  const section = () => {
    switch (tab) {
      case 'overview':
        return (
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
                  deployShot={deployShot}
                  repo={repo}
                  workspace={workspace}
                  workspaceRoot={workspaceRoot}
                  workspaceStatus={workspaceStatus}
                  d={d}
                />
              )
            }
          </GuardedAwait>
        )
      case 'deployments':
        return (
          <GuardedAwait
            resetKey={sectionKey}
            promise={tabData}
            fallback={<BlockSkeleton h={420} />}
          >
            {(td) => (td.kind !== 'deployments' ? null : <Deployments app={app} td={td} />)}
          </GuardedAwait>
        )
      case 'database':
        return (
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
        )
      case 'vpn':
        return (
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
        )
      case 'tasks':
        return (
          <GuardedAwait
            resetKey={sectionKey}
            promise={tabData}
            fallback={<BlockSkeleton h={300} />}
          >
            {(td) => (td.kind !== 'tasks' ? null : <Tasks app={app} td={td} />)}
          </GuardedAwait>
        )
      case 'access':
        return (
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
        )
      case 'settings':
        return (
          <Settings
            app={app}
            readOnly={readOnly}
            patch={patch}
            takenHostnames={takenHostnames}
            stateRoot={stateRoot}
          />
        )
      case 'variables':
        return (
          <GuardedAwait
            resetKey={sectionKey}
            promise={tabData}
            fallback={<BlockSkeleton h={300} />}
          >
            {(td) =>
              td.kind !== 'variables' ? null : (
                <Variables app={app} readOnly={readOnly} secrets={td.secrets} />
              )
            }
          </GuardedAwait>
        )
      case 'secrets':
        return (
          <GuardedAwait
            resetKey={sectionKey}
            promise={tabData}
            fallback={<BlockSkeleton h={400} />}
          >
            {(td) =>
              td.kind !== 'secrets' ? null : (
                <Secrets
                  app={app.name}
                  env={td.env}
                  hasSecretsFile={app.operatorSecrets}
                  secrets={td.secrets}
                />
              )
            }
          </GuardedAwait>
        )
      // Grafana renders these and does its own querying, so tabData is not
      // read here (lib/apps/tabs.ts says why it is empty). No Panel around
      // it: you are already on the Logs tab, so a box captioned "Logs" inside
      // it is a second label for the same thing.
      case 'logs':
        return <GrafanaLogs source={{ container: `app-${app.name}` }} title={`${app.name} logs`} />
    }
  }

  return (
    <>
      <Crumbs>
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>{' '}
        <span aria-hidden="true">›</span> {app.name}
      </Crumbs>

      <section className={HERO}>
        {/* The app's own icon, in a frame that keeps carrying state. Identity
            and health are different questions and the frame answers the second
            without spending the slot that answers the first. */}
        <div
          className={cn(HERO_ICON, iconTone !== undefined && HERO_ICON_TONED)}
          style={iconTone === undefined ? undefined : toneStyle(iconTone)}
        >
          <AppIcon name={app.name} hasIcon={app.hasIcon} size={34} />
        </div>

        <div>
          <h1 className="m-0 flex flex-wrap items-center gap-[0.65rem] text-[1.45rem] font-semibold tracking-[-0.02em] max-[34rem]:text-[1.3rem]">
            {app.name}
            <StatePill state={state} />
            {readOnly && (
              <Badge variant="outline" className={cn(CHIP, 'text-(--text-muted)')}>
                nix-managed
              </Badge>
            )}
          </h1>
          <p className={LEDE}>{app.description || 'No description.'}</p>
          <p className={HERO_LINKS}>
            {app.stage === 'declared' ? (
              <span className="text-(--text-muted)">◌ not running</span>
            ) : app.stage === 'off' ? (
              <span className="text-(--text-muted)">⏻ not exposed</span>
            ) : (
              <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
                ↗ {app.effectiveHostname}
              </a>
            )}
            {app.sourceMode === 'local' ? (
              <span className="text-(--text-muted)">⎇ stacks/{app.name}/app</span>
            ) : (
              <a
                href={`https://github.com/${appRepo(site, app.name)}`}
                target="_blank"
                rel="noreferrer"
              >
                ⎇ {appRepo(site, app.name)}
              </a>
            )}
          </p>
        </div>

        <div className={HERO_EXPOSURE}>
          <span className="mb-[0.4rem] block text-[0.73rem] text-(--dim)">exposure</span>
          <Segmented
            value={app.stage}
            disabled={readOnly}
            // The "exposure" text beside this is a bare span, not a <label>,
            // so the group still needs naming for assistive tech.
            label="Exposure"
            onChange={(v) => {
              patch({ stage: v })
            }}
            // Four rungs, each adding to the last. "Declared" runs nothing at
            // all: the row, its database, its data directory and its secrets,
            // and no container — where every app sits between being created
            // and having an image. "Off" adds the container back and withholds
            // only the ingress: no traefik router, no DNS, no probe, but it
            // runs and it deploys.
            options={[
              {
                value: 'declared',
                label: 'Declared',
                icon: '◌',
                // Refused like "Off" below, though stricter than the
                // platform: apps.nix's assertion lets a declared app keep
                // proxy mode for later, since it has no ingress to lose.
                disabled: app.authMode === 'proxy',
                reason:
                  app.authMode === 'proxy'
                    ? 'Auth is enforced at the ingress (proxy mode), so this app cannot be unexposed while it relies on that gate.'
                    : 'Nothing runs: no container, no deploy unit, no ingress. The database, the data directory and the secrets stay.',
              },
              {
                value: 'off',
                label: 'Off',
                icon: '⏻',
                // The forward-auth middleware is generated FROM the ingress,
                // so an app gated that way has nothing left to gate once the
                // ingress is gone. The platform asserts this
                // (nix/modules/apps/apps.nix); catching it here turns a failed
                // Apply into an explanation.
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
            <p className="mt-[0.45rem] mr-0 mb-0 ml-auto max-w-[15rem] text-right text-[0.72rem] text-(--dim)">
              No route, DNS or probe. The container still runs.
            </p>
          )}
          {app.stage === 'declared' && (
            <p className="mt-[0.45rem] mr-0 mb-0 ml-auto max-w-[15rem] text-right text-[0.72rem] text-(--dim)">
              Nothing runs. Its database, data directory and secrets exist.
            </p>
          )}
        </div>
      </section>

      {readOnly && (
        <Alert className="mb-[1.35rem] text-(--text-muted)">
          <AlertDescription>
            Declared by hand in <code>stacks/daedalus/daedalus.nix</code>, so it is read-only here.
            An Apply that broke this entry would take down the interface you would use to undo it.
          </AlertDescription>
        </Alert>
      )}

      {/* The last step of adding an app, on the page where it happens.
          `declared` is a resting state the platform is perfectly happy to
          leave an app in forever, and forever is what it would be if the only
          way to leave it were to remember the exposure control in the corner.
          One affordance, the one that is right in almost every case: internal.
          External is the same control above, one click further. */}
      {!readOnly && app.stage === 'declared' && (
        <Alert className="mb-[1.35rem]">
          <AlertTitle>Declared — nothing is running yet</AlertTitle>
          <AlertDescription>
            <p className="m-0">
              {drift.length > 0
                ? 'Apply first: that writes site/apps.json and rebuilds, which creates this app’s database, data directory and secrets — and is what lets the box build its repo at all. Then build it, and promote it here.'
                : 'Applied. Build it from its deployments tab; once that build has published an image, promote it and Apply again.'}
            </p>
            <div className="mt-[0.7rem] flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  patch({ stage: 'lab' })
                }}
              >
                Promote to internal
              </Button>
              <Link
                to="/apps/$name"
                params={{ name: app.name }}
                search={{ tab: 'deployments' as const }}
                className="text-[0.82rem]"
              >
                Builds and deployments →
              </Link>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* No tab bar here: inside an app the sections live in the left rail —
          the shell swaps the category nav for the app-scoped one while this
          route is matched (components/shell/app-rail.tsx). */}

      {section()}

      <ApplyBar
        changed={readOnly || drift.length === 0 ? [] : [{ name: app.name, fields: drift }]}
        initialStatus={applyStatus}
      />
    </>
  )
}
