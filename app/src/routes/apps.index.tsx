import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useMemo, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { CHIP, SECTION_HEAD, SECTION_HEAD_SMALL } from '../components/apps/shared'
import { AppIcon, type AppState, Segmented, StateDot } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { PageHead } from '../components/page'
import { ImagesView, PackagesView } from '../components/registries'
import { BoardsSkeleton, RowsSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Spark } from '../components/viz'
import { CloneButton } from '../components/workspace'
import { cn } from '../lib/cn'
import { PLATFORMS, type Platform } from '../lib/external-apps'
import { fetchApps, fetchImagesTab, fetchPackagesTab } from '../server/registry'
import { fetchSiteEdit } from '../server/site'

// The app list. Every row joins three sources: the registry (Postgres — what
// daedalus believes), the Nix manifest (what the box was actually built from,
// hence drift), and Prometheus (what is happening right now).

// Three tabs, the same shape every category page uses: what this box runs, and
// the two registries it is built out of.
//
// The registries were boards at the foot of the app list. They are services —
// containers with release cycles, logs and neighbours — and as a footer they
// got a handful of numbers and no room for any of that. A tab each gives them
// the header, version verdict, changelog and log every other service here has,
// and it takes the app list back to being one thing.
const TABS = [
  { id: 'apps', label: 'Apps' },
  { id: 'images', label: 'Container registry' },
  { id: 'packages', label: 'npm packages' },
] as const

type Tab = (typeof TABS)[number]['id']

export const Route = createFileRoute('/apps/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.some((t) => t.id === search.tab) ? (search.tab as Tab) : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? ('apps' as const) }),
  // Only the open tab's data is fetched. The registries are two upstreams
  // through traefik plus a GitHub release lookup each, and the app list is a
  // Postgres read — pairing them cost the fast one every time.
  loader: ({ deps }) => ({
    tab: deps.tab,
    list: deps.tab === 'apps' ? fetchAppsTab() : null,
    images: deps.tab === 'images' ? fetchImagesTab() : null,
    packages: deps.tab === 'packages' ? fetchPackagesTab() : null,
  }),
  component: AppsPage,
})

/**
 * The app list plus the site document's pending fields. One Apply writes
 * both files and rebuilds once, so the bar at the foot of this page has to
 * say everything that Apply will do — not just the apps' half of it.
 */
async function fetchAppsTab() {
  const [list, site] = await Promise.all([fetchApps(), fetchSiteEdit()])
  return { ...list, siteChanges: site.changes }
}

type ListData = Awaited<ReturnType<typeof fetchAppsTab>>
type Row = ListData['apps'][number]
type ExternalEntry = ListData['external'][number]

/* A grid of project cards, the Vercel shape. Rows were tried first (one
   bordered list, hairline separators) and spent a 1200px line on five facts:
   the identity hugged the left edge, the readings the right, and the middle
   was gap. A card puts the same facts in ~300px, three or four abreast, and
   collapses to one column on a phone with no special-casing — which is also
   why there is no narrow-viewport rule for it.

   Exported for `RowsSkeleton`, so the placeholder reserves this grid and not
   an approximation of it. */
export const APP_LIST =
  'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] gap-[0.8rem] p-0'

const TALLIES =
  'mb-[1.1rem] flex flex-wrap items-center gap-x-[1.6rem] gap-y-2 text-[0.88rem] text-(--text-muted) max-[34rem]:gap-x-4 max-[34rem]:gap-y-[0.4rem]'
const TALLY = 'inline-flex items-center gap-[0.45rem]'
const TALLY_COUNT = 'font-semibold text-foreground'

const CARD =
  'flex min-w-0 flex-col rounded-lg border border-(--border-soft) bg-card transition-colors duration-150 hover:border-foreground/30'
/** Off-box and control-plane cards: dashed, the visual for "listed here, not
    one of the things being managed". */
const CARD_ASIDE = 'border-dashed bg-transparent'
/* The whole card is the link; the foot rides inside it so one hover means
   one destination. External cards break this on purpose — their actions bar
   is a sibling of the anchor (a button in an anchor is one click with two
   meanings, and invalid HTML besides). */
const CARD_LINK =
  'flex min-w-0 flex-1 flex-col gap-[0.55rem] px-4 pt-[0.85rem] pb-[0.9rem] text-inherit hover:no-underline'
const CARD_HEAD = 'flex min-w-0 items-center gap-[0.65rem]'
const APP_NAME = 'flex min-w-0 items-center gap-2 text-[0.95rem] [font-weight:550]'
const APP_HOST = 'block truncate text-[0.76rem] text-(--dim)'
/** Two lines, then quiet: a card column where one long description makes one
    row twice as tall reads as a layout accident. */
const APP_DESC = 'm-0 line-clamp-2 text-[0.8rem] leading-[1.45] text-(--text-muted)'
/** The spark sizes itself from its height and is pushed to the right edge. */
const CARD_FOOT = 'mt-auto flex items-center gap-[0.6rem] pt-[0.15rem] [&>svg]:ml-auto'

/** The exposure chip, by stage. `lab` is the fourth status colour: a fact
    about where the app is reachable, not a verdict on it. */
const STAGE_CHIP: Record<
  'live' | 'lab' | 'off',
  { variant: 'success' | 'outline'; className: string }
> = {
  live: { variant: 'success', className: CHIP },
  lab: { variant: 'outline', className: cn(CHIP, 'border-info/35 bg-info/8 text-info') },
  off: { variant: 'outline', className: cn(CHIP, 'text-(--dim)') },
}

function AppsPage() {
  const { tab, list, images, packages } = Route.useLoaderData()

  return (
    <>
      <PageHead title="Apps">
        What this box runs of its own, what lives on someone else's infrastructure, and the two
        registries everything here is built out of.
      </PageHead>

      <TabBar tabs={TABS} active={tab} linkTo={(id) => ({ to: '/apps', search: { tab: id } })} />

      {list !== null && (
        <GuardedAwait resetKey={tab} promise={list} fallback={<RowsSkeleton count={4} />}>
          {(data) => <AppsList data={data} />}
        </GuardedAwait>
      )}

      {images !== null && (
        <GuardedAwait
          resetKey={tab}
          promise={images}
          fallback={<BoardsSkeleton spans={[8, 4, 8, 4]} />}
        >
          {(data) => <ImagesView d={data} />}
        </GuardedAwait>
      )}

      {packages !== null && (
        <GuardedAwait
          resetKey={tab}
          promise={packages}
          fallback={<BoardsSkeleton spans={[6, 6, 12]} />}
        >
          {(data) => <PackagesView d={data} />}
        </GuardedAwait>
      )}
    </>
  )
}

export function AppsList({ data }: { data: ListData }) {
  const { apps, applyStatus, external, workspaceStatus } = data
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'all' | AppState>('all')
  const [exposure, setExposure] = useState<'all' | 'live' | 'lab' | 'off'>('all')

  const counts = useMemo(
    () => ({
      running: apps.filter((r) => r.status.state === 'running').length,
      attention: apps.filter((r) => r.status.state === 'attention').length,
      stopped: apps.filter((r) => r.status.state === 'stopped' || r.status.state === 'unknown')
        .length,
    }),
    [apps],
  )

  const visible = apps.filter(
    (r) =>
      (state === 'all' || r.status.state === state) &&
      (exposure === 'all' || r.stage === exposure) &&
      (search === '' || `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase())),
  )

  // Nix-managed entries (the control plane itself) render in their own
  // section, so the list above is exactly "the apps daedalus manages".
  const managed = visible.filter((r) => !r.managedInNix)
  const platform = visible.filter((r) => r.managedInNix)

  // The off-box projects answer the search box but not the state/exposure
  // filters — nothing here probes them, so they have no state to match, and
  // pretending "external hosting" is an exposure would put them under a
  // filter that means "published through the tunnel". They simply step aside
  // while either filter is narrowing.
  const offBox =
    state === 'all' && exposure === 'all'
      ? external.filter(
          (e) =>
            search === '' ||
            `${e.name} ${e.host} ${e.description}`.toLowerCase().includes(search.toLowerCase()),
        )
      : []

  // The control plane's own row carries whether it serves an icon, so the
  // section head borrows it rather than probing again.
  const selfHasIcon = apps.find((a) => a.name === 'daedalus')?.hasIcon ?? false

  const changed = [
    ...apps
      .filter((a) => !a.managedInNix && a.drift.length > 0)
      .map((a) => ({ name: a.name, fields: a.drift })),
    ...(data.siteChanges.length > 0 ? [{ name: 'site', fields: [...data.siteChanges] }] : []),
  ]

  return (
    <>
      <div className={TALLIES}>
        <span className={TALLY}>
          <StateDot state="running" /> <b className={TALLY_COUNT}>{counts.running}</b> running
        </span>
        <span className={TALLY}>
          <StateDot state="attention" /> <b className={TALLY_COUNT}>{counts.attention}</b> need
          attention
        </span>
        <span className={TALLY}>
          <StateDot state="stopped" /> <b className={TALLY_COUNT}>{counts.stopped}</b> stopped
        </span>
        {/* The create flow is a page rather than a dialog: it makes a GitHub
            round trip per repo it checks, and a checklist you can leave open
            in a tab while you go fix a workflow is worth more than one that
            closes when you click outside it. Parked at the end of the tally
            line rather than in the page header — the header is shared by all
            three tabs, and adding an app is only one of them. */}
        <Button asChild size="sm" className="ml-auto">
          <Link to="/apps/new">Add an app</Link>
        </Button>
      </div>

      <div className="mb-[1.3rem] flex flex-wrap gap-[0.6rem]">
        <Input
          className="flex-[1_1_15rem]"
          type="search"
          placeholder="Search apps…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
          }}
        />
        <Segmented
          value={state}
          onChange={setState}
          label="Filter by state"
          options={[
            { value: 'all', label: 'all' },
            { value: 'running', label: 'running' },
            { value: 'attention', label: 'issues' },
            { value: 'stopped', label: 'stopped' },
          ]}
        />
        <Segmented
          value={exposure}
          onChange={setExposure}
          label="Filter by exposure"
          options={[
            { value: 'all', label: 'all' },
            { value: 'live', label: 'external' },
            { value: 'lab', label: 'internal' },
            { value: 'off', label: 'off' },
          ]}
        />
      </div>

      <SectionHead
        icon={<AppIcon name="daedalus" hasIcon={selfHasIcon} size={15} />}
        title="Daedalus"
        sub="deployed, watched and managed on this box"
      />
      <ul className={APP_LIST}>
        {managed.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
        {managed.length === 0 && <li className="py-10 text-(--dim)">No apps match that filter.</li>}
      </ul>

      {/* The control plane sits below its own rule rather than in the list.
          It is not one of the things being managed — it is the thing doing the
          managing, it is declared by hand in Nix, and every control on it is
          read-only. Mixing it in invites you to try editing it. */}
      {platform.length > 0 && (
        <>
          <h2 className={SECTION_HEAD}>
            Control plane
            <small className={SECTION_HEAD_SMALL}>declared in Nix, not editable here</small>
          </h2>
          <ul className={APP_LIST}>
            {platform.map((r) => (
              <AppRow key={r.name} row={r} aside />
            ))}
          </ul>
        </>
      )}

      {/* Projects hosted off the box, one section per platform. The registry
          knows nothing about them — the list is a hand-edited literal
          (lib/external-apps.ts) — so the rows link out to the site itself
          rather than to a detail page there is no data to fill. */}
      {PLATFORMS.map((p) => {
        const entries = offBox.filter((e) => e.platform === p.id)
        if (entries.length === 0) return null
        return (
          <div key={p.id}>
            <SectionHead icon={PLATFORM_ICONS[p.id]} title={p.id} sub={p.description} />
            <ul className={APP_LIST}>
              {entries.map((e) => (
                <ExternalRow key={e.id} entry={e} workspaceStatus={workspaceStatus} />
              ))}
            </ul>
          </div>
        )
      })}

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </>
  )
}

function SectionHead({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <h2 className={SECTION_HEAD}>
      {/* Centred by hand because the head aligns its text on the baseline,
          which an image does not have. */}
      <span className="inline-flex self-center text-(--text-muted)" aria-hidden="true">
        {icon}
      </span>
      {title}
      <small className={SECTION_HEAD_SMALL}>{sub}</small>
    </h2>
  )
}

// The two brand marks, inlined. NOT in glyph.tsx, on that file's own rule:
// its set is stroke pictographs named by shape, and these are filled logos
// that are nothing without their subject. `currentColor` keeps them on the
// section head's own grey in both themes.
const PLATFORM_ICONS: Record<Platform, ReactNode> = {
  'GitHub Pages': (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" role="presentation">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ),
  Vercel: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" role="presentation">
      <path d="M12 2.5 23 21.5H1L12 2.5Z" />
    </svg>
  ),
}

function ExternalRow({
  entry,
  workspaceStatus,
}: {
  entry: ExternalEntry
  workspaceStatus: ListData['workspaceStatus']
}) {
  // The actions live BESIDE the row's anchor, not inside it — a button in an
  // anchor is one click with two meanings, and invalid HTML besides. The row
  // still links to the site; the trailing cell links to the repo and holds
  // the one workspace action these projects have (no detail page to put it
  // on — see the section comment above). No dot and no spark — nothing on
  // this box probes those sites — so the card simply doesn't draw the
  // readings it doesn't have.
  return (
    <li className={cn(CARD, CARD_ASIDE)}>
      <a href={`https://${entry.host}`} target="_blank" rel="noreferrer" className={CARD_LINK}>
        <div className={CARD_HEAD}>
          <AppIcon name={entry.id} hasIcon={entry.hasIcon} size={30} />
          <div className="min-w-0 flex-1">
            <div className={APP_NAME}>{entry.name}</div>
            <code className={APP_HOST}>{entry.host}</code>
          </div>
        </div>
        <p className={APP_DESC}>{entry.description}</p>
      </a>
      {entry.repo !== null && (
        <div className="flex min-w-0 items-center justify-between gap-[0.9rem] border-t border-t-(--border-soft) px-4 pt-[0.6rem] pb-[0.75rem] text-[0.8rem]">
          <a
            className="min-w-0 truncate text-(--text-muted)"
            href={`https://github.com/${entry.repo}`}
            target="_blank"
            rel="noreferrer"
            title={
              entry.workspace
                ? `cloned — ${entry.workspace.branch ?? '?'} @ ${entry.workspace.head ?? '?'}${entry.workspace.dirty ? ', uncommitted changes' : ''}`
                : 'not cloned on this box'
            }
          >
            ⎇ {entry.repo}
          </a>
          <CloneButton
            repo={entry.repo}
            cloned={entry.workspace !== null}
            initial={workspaceStatus}
          />
        </div>
      )}
    </li>
  )
}

function AppRow({ row, aside = false }: { row: Row; aside?: boolean }) {
  const stage =
    row.stage === 'live' ? STAGE_CHIP.live : row.stage === 'off' ? STAGE_CHIP.off : STAGE_CHIP.lab
  return (
    <li className={cn(CARD, aside && CARD_ASIDE)}>
      {/* `tab` is a required search param on the detail route (it is what
          makes the tab linkable and server-rendered), so the list has to name
          the landing tab explicitly. */}
      <Link
        to="/apps/$name"
        params={{ name: row.name }}
        search={{ tab: 'overview' as const }}
        className={CARD_LINK}
      >
        <div className={CARD_HEAD}>
          <AppIcon name={row.name} hasIcon={row.hasIcon} size={30} />
          <div className="min-w-0 flex-1">
            <div className={APP_NAME}>
              {row.name}
              {row.managedInNix && (
                <Badge
                  variant="outline"
                  className={cn(CHIP, 'text-(--text-muted)')}
                  title="Declared by hand in Nix, read-only here"
                >
                  nix
                </Badge>
              )}
              {!row.managedInNix && row.drift.length > 0 && (
                <Badge
                  variant="warning"
                  className={CHIP}
                  title={`Changed: ${row.drift.join(', ')}`}
                >
                  unapplied
                </Badge>
              )}
            </div>
            <code className={APP_HOST}>{row.hostname}</code>
          </div>
          <StateDot state={row.status.state} />
        </div>

        <p className={APP_DESC}>{row.description || '—'}</p>

        <div className={CARD_FOOT}>
          <Badge variant={stage.variant} className={stage.className}>
            {row.stage === 'live' ? 'external' : row.stage === 'off' ? 'not exposed' : 'internal'}
          </Badge>

          {/* Neutral unless the app is in trouble: the dot in the head
              already carries state, and a green line on every healthy app
              would make the one red line harder to find, not easier. */}
          <Spark
            values={row.status.spark}
            tone={row.status.state === 'attention' ? 'bad' : 'muted'}
            width={72}
            height={18}
          />
          <span className="text-[0.74rem] text-(--dim) tabular-nums">
            {row.status.rpm === null ? '—' : `${row.status.rpm.toFixed(1)} rpm`}
          </span>
        </div>
      </Link>
    </li>
  )
}
