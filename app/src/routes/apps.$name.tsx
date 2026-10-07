import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ArrowUpRightIcon,
  CircleOffIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  LoaderIcon,
} from 'lucide-react'
import { ApplyBar } from '../components/apply-bar'
import { SetupLine } from '../components/apps/setup-line'
import { type AppRecord, CHIP, SegmentPicker } from '../components/apps/shared'
import { TabBody } from '../components/apps/tab-views'
import { AppIcon, type AppState, StatePill } from '../components/controls'
import { Crumbs, PageHead } from '../components/page'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
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
import { STAGE_LABEL } from '../lib/stage'
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

/* The head: the page's title row, not a card. The app is the page, so its
   identity is set like every other page title — on the panel, with the
   exposure switch where a page keeps its one control. Below the rail
   breakpoint exposure drops to a full-width row under the title. */
const HERO =
  'mb-8 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-4 max-rail:grid-cols-[auto_minmax(0,1fr)]'
const HERO_ICON =
  'grid size-12 place-items-center rounded-xl border border-hairline bg-foreground/[0.04] shadow-[inset_0_1px_0_var(--hairline-hi)] max-rail:size-10'
/** Only the fault tints the frame: a running app is the norm and says so with
    its pill, so a green frame beside a green pill was the same fact twice. */
const HERO_ICON_TONED =
  'border-[color-mix(in_oklch,var(--tone)_35%,transparent)] bg-[color-mix(in_oklch,var(--tone)_8%,transparent)]'
const ICON_TONE: Partial<Record<AppState, Tone>> = { attention: 'bad' }
const HERO_TITLE =
  'm-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[1.75rem] leading-tight tracking-[-0.028em] [font-weight:640] max-[34rem]:text-[1.35rem]'
const HERO_DESC = 'mt-1 mb-0 max-w-[72ch] text-[0.9rem] text-muted-foreground'
/** Where it answers and where its code lives: quiet links, an icon each. */
const HERO_LINKS =
  'mt-2.5 mb-0 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.8rem] max-[34rem]:flex-col max-[34rem]:items-start'
const HERO_LINK =
  'inline-flex min-w-0 items-center gap-1.5 font-mono text-[0.78rem] text-subdued no-underline hover:text-foreground hover:no-underline [&>svg]:size-3.5 [&>svg]:flex-none [&>svg]:text-muted-foreground'
/* The exposure switch goes full-width below the rail breakpoint, where it sits
   alone in its own row — the descendant rules tell it so. */
const HERO_EXPOSURE =
  'flex flex-col items-end gap-2 pt-1 max-rail:col-span-full max-rail:items-start max-rail:pt-0 max-rail:[&_[role=radiogroup]]:flex max-rail:[&_[role=radiogroup]]:w-full max-rail:[&_[role=radiogroup]]:max-w-[22.5rem] max-rail:[&_[role=radio]]:flex-1 max-rail:[&_[role=radio]]:justify-center max-[40rem]:items-stretch max-[40rem]:[&_[role=radiogroup]]:max-w-none'
const EXPOSURE_NOTE =
  'm-0 max-w-[16rem] text-right text-[0.75rem] text-muted-foreground max-rail:max-w-none max-rail:text-left'
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
  const { app, drift, status, applyStatus, setup, tabData } = loaded
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
      {/* No breadcrumb: the app rail's "All apps" is the way back, and a
          trail saying "Apps › iris" above a title saying "iris" was the same
          fact twice. */}
      <AppHero app={app} state={state} patch={patch} />

      {save.error !== null && (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>The change was not saved</AlertTitle>
          <AlertDescription>{save.error}</AlertDescription>
        </Alert>
      )}

      {readOnly && (
        <Alert className="mb-5 text-subdued">
          <AlertDescription>
            Declared by hand in <code>stacks/daedalus/daedalus.nix</code>, so it is read-only here.
            An Apply that broke this entry would take down the interface you would use to undo it.
          </AlertDescription>
        </Alert>
      )}

      {/* A new app on its way to its first container (lib/apps/setup.ts). */}
      {!readOnly && setup !== null && <SetupLine name={app.name} setup={setup} />}

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
  return (
    <header className={HERO}>
      {/* The app's own icon, in a frame that turns red only when the app
          needs attention. Identity and health are different questions; the
          frame answers the second only when the answer is news. */}
      <div
        className={cn(HERO_ICON, iconTone !== undefined && HERO_ICON_TONED)}
        style={iconTone === undefined ? undefined : toneStyle(iconTone)}
      >
        <AppIcon name={app.name} hasIcon={app.hasIcon} size={30} />
      </div>

      <div className="min-w-0">
        <h1 className={HERO_TITLE}>
          {app.name}
          {/* Running is the norm: the pill appears only when it is news. */}
          {state !== 'running' && <StatePill state={state} />}
          {readOnly && <Chip className={cn(CHIP, 'text-subdued')}>nix-managed</Chip>}
        </h1>
        <p className={HERO_DESC}>{app.description || 'No description.'}</p>
        <p className={HERO_LINKS}>
          {app.awaitingImage ? (
            <span className={HERO_LINK}>
              <LoaderIcon aria-hidden="true" />
              not running yet
            </span>
          ) : app.stage === 'off' ? (
            <span className={HERO_LINK}>
              <CircleOffIcon aria-hidden="true" />
              not exposed
            </span>
          ) : (
            <a
              className={HERO_LINK}
              href={`https://${app.effectiveHostname}`}
              target="_blank"
              rel="noreferrer"
            >
              <GlobeIcon aria-hidden="true" />
              {app.effectiveHostname}
              <ArrowUpRightIcon aria-hidden="true" className="-ml-0.5 size-3! opacity-60" />
            </a>
          )}
          {app.sourceMode === 'local' ? (
            <span className={HERO_LINK}>
              <FolderIcon aria-hidden="true" />
              stacks/{app.name}/app
            </span>
          ) : (
            <a
              className={HERO_LINK}
              href={`https://github.com/${appRepo(site, app.name)}`}
              target="_blank"
              rel="noreferrer"
            >
              <GitBranchIcon aria-hidden="true" />
              {appRepo(site, app.name)}
              <ArrowUpRightIcon aria-hidden="true" className="-ml-0.5 size-3! opacity-60" />
            </a>
          )}
        </p>
      </div>

      <div className={HERO_EXPOSURE}>
        <div className="flex items-center gap-2.5 max-[40rem]:flex-col max-[40rem]:items-stretch max-[40rem]:gap-1.5">
          <span className="translate-y-px text-[0.75rem] text-muted-foreground">Exposure</span>
          <SegmentPicker
            value={app.stage}
            disabled={readOnly}
            // The "exposure" text beside this is a bare span, not a <label>,
            // so the group still needs naming for assistive tech.
            label="Exposure"
            onChange={(v) => {
              patch({ stage: v })
            }}
            // Three rungs, each adding to the last. "Off" runs the container
            // and withholds only the ingress: no traefik router, no DNS, no
            // probe, but it runs and it deploys. A new app picks its rung
            // before it has an image: nothing of it exists until then
            // (lib/apps/setup.ts), so the choice is free.
            options={[
              {
                value: 'off',
                label: STAGE_LABEL.off,
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
              { value: 'lab', label: STAGE_LABEL.lab, icon: '⛨' },
              { value: 'live', label: STAGE_LABEL.live, icon: '↗' },
            ]}
          />
        </div>
        {app.awaitingImage ? (
          <p className={EXPOSURE_NOTE}>Where it runs once its first image is in.</p>
        ) : (
          app.stage === 'off' && (
            <p className={EXPOSURE_NOTE}>No route, DNS or probe. The container still runs.</p>
          )
        )}
      </div>
    </header>
  )
}
