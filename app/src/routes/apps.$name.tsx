import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ApplyBar } from '../components/apply-bar'
import { type AppRecord, CHIP, LEDE } from '../components/apps/shared'
import { TabBody } from '../components/apps/tab-views'
import { AppIcon, type AppState, Segmented, StatePill } from '../components/controls'
import { Crumbs, PageHead } from '../components/page'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { useAction } from '../components/use-action'
import { Chip } from '../components/viz'
// lib/access-window, NOT host/access. The window table is a value the picker
// and validateSearch both need in the browser; host/access talks to Loki and
// must never follow it there.
import { type AccessWindow, DEFAULT_WINDOW, isAccessWindow } from '../lib/access-window'
import type { AppPatch } from '../lib/apps/validate'
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
  'mb-6 grid grid-cols-[auto_1fr_auto] items-start gap-5 rounded-xl border border-subtle bg-card px-6 py-[1.35rem] max-rail:grid-cols-[auto_minmax(0,1fr)] max-rail:gap-x-4 max-rail:gap-y-[0.9rem] max-rail:p-[1.1rem]'
const HERO_ICON =
  'grid size-[54px] place-items-center rounded-[12px] border bg-raised text-[1.4rem] text-muted-foreground max-rail:size-[42px] max-rail:text-[1.15rem]'
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
const EXPOSURE_NOTE =
  'mt-[0.45rem] mr-0 mb-0 ml-auto max-w-[15rem] text-right text-[0.72rem] text-muted-foreground'
/** Why the running rungs are closed to an app with no image yet; absent when they are open. */
const IMAGE_WAIT: Partial<Record<NonNullable<AppRecord['firstImage']>, string>> = {
  missing: "First build pending. The container can run once its image is in the box's registry.",
  unknown: "The box's registry did not answer, so whether this app has an image yet is not known.",
}

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
  const loaded = Route.useLoaderData()
  const { app, drift, status, applyStatus, tabData } = loaded
  const { tab, range } = Route.useSearch()

  const readOnly = app.managedInNix
  const state = status?.state ?? 'unknown'

  // What un-errors a failed tab body: anything that makes the loader hand
  // over a fresh tabData promise. The range is part of it so widening the
  // access window is itself a retry.
  const sectionKey = `${tab}:${range ?? ''}`

  // Edits go straight to Postgres — the database IS the working copy, and the
  // drift banner is what marks it as not-yet-applied. There is no separate
  // client-side draft to lose on a refresh. A refused edit (a validation
  // error, a lost session) shows above the sections rather than vanishing.
  const save = useAction()
  const patch = (p: AppPatch) => {
    save.run(() => saveApp({ data: { name: app.name, patch: p } }))
  }

  return (
    <>
      <Crumbs>
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>{' '}
        <span aria-hidden="true">›</span> {app.name}
      </Crumbs>

      <AppHero app={app} state={state} patch={patch} />

      {save.error !== null && (
        <Alert variant="destructive" className="mb-[1.35rem]">
          <AlertTitle>The change was not saved</AlertTitle>
          <AlertDescription>{save.error}</AlertDescription>
        </Alert>
      )}

      {readOnly && (
        <Alert className="mb-[1.35rem] text-subdued">
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

      <TabBody
        tab={tab}
        tabData={tabData}
        resetKey={sectionKey}
        ctx={{ frame: loaded, range: range ?? DEFAULT_WINDOW, patch }}
      />

      <ApplyBar
        changed={readOnly || drift.length === 0 ? [] : [{ name: app.name, fields: drift }]}
        initialStatus={applyStatus}
      />
    </>
  )
}

/** Identity on the left, exposure on the right: the app's icon, name, links and stage. */
function AppHero({
  app,
  state,
  patch,
}: {
  app: AppRecord
  state: AppState
  patch: (p: AppPatch) => void
}) {
  const site = useSite()
  const readOnly = app.managedInNix
  const iconTone = ICON_TONE[state]
  const imageWait = app.firstImage === null ? undefined : IMAGE_WAIT[app.firstImage]
  return (
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
          {readOnly && <Chip className={cn(CHIP, 'text-subdued')}>nix-managed</Chip>}
        </h1>
        <p className={LEDE}>{app.description || 'No description.'}</p>
        <p className={HERO_LINKS}>
          {app.stage === 'declared' ? (
            <span className="text-subdued">◌ not running</span>
          ) : app.stage === 'off' ? (
            <span className="text-subdued">⏻ not exposed</span>
          ) : (
            <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
              ↗ {app.effectiveHostname}
            </a>
          )}
          {app.sourceMode === 'local' ? (
            <span className="text-subdued">⎇ stacks/{app.name}/app</span>
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
        <span className="mb-[0.4rem] block text-[0.73rem] text-muted-foreground">exposure</span>
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
          //
          // Every rung that runs a container waits for the first image: an
          // Apply that declares one with nothing to pull fails the switch and
          // rolls back (lib/apps/image-gate.ts). The save and the Apply refuse
          // it too; this is where it is explained.
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
              disabled: imageWait !== undefined || app.authMode === 'proxy',
              reason:
                imageWait ??
                (app.authMode === 'proxy'
                  ? 'Auth is enforced at the ingress (proxy mode), so this app cannot be unexposed while it relies on that gate.'
                  : undefined),
            },
            {
              value: 'lab',
              label: 'Internal',
              icon: '⛨',
              disabled: imageWait !== undefined,
              reason: imageWait,
            },
            {
              value: 'live',
              label: 'External',
              icon: '↗',
              disabled: imageWait !== undefined,
              reason: imageWait,
            },
          ]}
        />
        {app.stage === 'off' && (
          <p className={EXPOSURE_NOTE}>No route, DNS or probe. The container still runs.</p>
        )}
        {app.stage === 'declared' && (
          <p className={EXPOSURE_NOTE}>
            {imageWait === undefined
              ? 'Nothing runs. Its database, data directory and secrets exist.'
              : app.firstImage === 'missing'
                ? 'First build pending. The other rungs open once it has published an image.'
                : imageWait}
          </p>
        )}
      </div>
    </section>
  )
}
