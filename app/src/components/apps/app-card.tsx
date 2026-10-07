// One row of the apps list: an app on the box, or a project that is not.
//
// A table, not a wall of cards. Every row shares one column grid, so the eye
// runs DOWN a column — every address, every traffic line, every "deployed" —
// which is how a list of things you run is read. The grid answers to the
// list's own width (`@container/applist`): columns step away as it narrows;
// the app and its status never do.
import { Link } from '@tanstack/react-router'
import { CircleOffIcon, FlaskConicalIcon, GlobeIcon, LoaderIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { Platform, SiteState } from '../../lib/external-apps'
import { type AppStage, isAppStage } from '../../lib/stage'
import { Ago } from '../ago'
import { AppIcon, type AppState, StateDot } from '../controls'
import { Chip, Spark } from '../viz'
import { CloneButton } from '../workspace'
import type { ExternalEntry, Row } from './apps-list'
import { CHIP } from './shared'

// The two brand marks, inlined. NOT in glyph.tsx, on that file's own rule:
// its set is stroke pictographs named by shape, and these are filled logos
// that are nothing without their subject. `currentColor` keeps them on the
// section head's own grey in both themes.
export const PLATFORM_ICONS: Record<Platform, ReactNode> = {
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

/** A site's platform state as the dot's vocabulary. */
export const SITE_DOT: Record<SiteState, AppState> = {
  live: 'running',
  building: 'unknown',
  failed: 'attention',
  unknown: 'unknown',
}

/* ── the table ─────────────────────────────────────────────────────────── */

/** The list's frame: one glass panel, rows inside it. A query container, so
    the rows lay out from the width the list actually has. */
export const APP_TABLE =
  '@container/applist m-0 list-none overflow-hidden rounded-2xl border border-hairline bg-surface p-0 shadow-[inset_0_1px_0_var(--hairline-hi),var(--board-shadow)]'

/** Six columns wide, four in a laptop half-window, two on a phone. */
export const APP_GRID = cn(
  'grid items-center gap-x-5 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,12rem)_5.5rem_9rem_6.5rem_8rem]',
  '@max-[64rem]/applist:grid-cols-[minmax(0,1fr)_5.5rem_9rem_8rem]',
  '@max-[38rem]/applist:grid-cols-[minmax(0,1fr)_8rem]',
)
const SITE_GRID = cn(
  'grid items-center gap-x-5 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,14rem)_6.5rem_8rem]',
  '@max-[64rem]/applist:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_8rem]',
  '@max-[38rem]/applist:grid-cols-[minmax(0,1fr)_8rem]',
)
/** A cell that steps away below a laptop half-window, and one below a phone. */
export const WIDE = '@max-[64rem]/applist:hidden'
export const MID = '@max-[38rem]/applist:hidden'

const HEAD =
  'h-9 border-hairline border-b text-[0.72rem] text-muted-foreground [font-weight:500] [&>span:last-child]:text-right'

/** A row: the whole of it is the link (`after:` stretches the name's anchor). */
export const ROW =
  'relative min-h-[3.75rem] border-hairline border-t py-2.5 transition-colors duration-100 [&:nth-child(2)]:border-t-0 hover:bg-foreground/[0.025] has-[a:focus-visible]:bg-foreground/[0.04]'
const STRETCH =
  'text-inherit no-underline outline-none after:absolute after:inset-0 hover:no-underline'

const NAME = 'flex min-w-0 items-center gap-2 text-[0.875rem] text-foreground [font-weight:560]'
const DESC = 'm-0 truncate text-[0.78rem] text-muted-foreground'
const MONO_CELL = 'min-w-0 truncate font-mono text-[0.75rem] text-muted-foreground'
const QUIET = 'text-[0.78rem] text-muted-foreground tabular-nums'

/** The first column: icon, name (with its badges), description. */
function Identity({
  icon,
  link,
  badges,
  desc,
}: {
  icon: ReactNode
  link: ReactNode
  badges?: ReactNode
  desc: string | null
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="inline-flex size-8 flex-none overflow-hidden rounded-[9px] shadow-[0_0_0_1px_var(--hairline)]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className={NAME}>
          {link}
          {badges}
        </div>
        {desc !== null && desc !== '' && <p className={DESC}>{desc}</p>}
      </div>
    </div>
  )
}

const STATE_LABEL: Record<AppState, string> = {
  running: 'Running',
  attention: 'Needs attention',
  stopped: 'Stopped',
  unknown: 'Unknown',
}

/** Status, at the row's end: the dot and its word. */
function Status({ state, label }: { state: AppState; label?: string }) {
  const word = label ?? STATE_LABEL[state]
  return (
    <span className="flex min-w-0 items-center justify-end gap-2 text-[0.78rem] text-subdued">
      <StateDot state={state} label={word} />
      <span className="truncate">{word}</span>
    </span>
  )
}

const EXPOSURE: Record<AppStage, { icon: ReactNode; label: string; title: string }> = {
  live: { icon: <GlobeIcon />, label: 'Public', title: 'Reachable from the internet' },
  lab: { icon: <FlaskConicalIcon />, label: 'Lab', title: 'Reachable on the LAN and VPN only' },
  off: { icon: <CircleOffIcon />, label: 'Off', title: 'Not published' },
}

export function AppTableHead() {
  return (
    <li aria-hidden="true" className={cn(APP_GRID, HEAD)}>
      <span>App</span>
      <span className={WIDE}>Address</span>
      <span className={MID}>Exposure</span>
      <span className={MID}>Traffic</span>
      <span className={WIDE}>Deployed</span>
      <span>Status</span>
    </li>
  )
}

export function SiteTableHead() {
  return (
    <li aria-hidden="true" className={cn(SITE_GRID, HEAD)}>
      <span>Site</span>
      <span className={MID}>Address</span>
      <span className={WIDE}>Repository</span>
      <span className={WIDE}>Deployed</span>
      <span>Status</span>
    </li>
  )
}

export function AppRow({ row }: { row: Row }) {
  // The column is text, so a value the ladder does not know is possible in
  // principle; it reads as the platform's own default rather than as nothing.
  const exposure = EXPOSURE[isAppStage(row.stage) ? row.stage : 'lab']
  return (
    <li className={cn(APP_GRID, ROW)}>
      <Identity
        icon={<AppIcon name={row.name} hasIcon={row.hasIcon} size={32} />}
        desc={row.description}
        link={
          // `tab` is a required search param on the detail route, so the list
          // names the landing tab explicitly.
          <Link
            to="/apps/$name"
            params={{ name: row.name }}
            search={{ tab: 'overview' as const }}
            className={cn(STRETCH, 'truncate')}
          >
            {row.name}
          </Link>
        }
        badges={
          <>
            {row.managedInNix && (
              <Chip tone="muted" className={CHIP} title="Declared by hand in Nix, read-only here">
                nix
              </Chip>
            )}
            {!row.managedInNix && row.drift.length > 0 && (
              <Chip tone="warn" className={CHIP} title={`Changed: ${row.drift.join(', ')}`}>
                unapplied
              </Chip>
            )}
          </>
        }
      />

      <code className={cn(MONO_CELL, WIDE)}>{row.hostname}</code>

      <span
        className={cn(
          MID,
          'inline-flex items-center gap-1.5 text-[0.78rem] text-subdued [&>svg]:size-3.5 [&>svg]:opacity-60',
        )}
        title={row.isNew ? 'Setting up: this is where it will run' : exposure.title}
      >
        {row.isNew ? <LoaderIcon /> : exposure.icon}
        {row.isNew ? 'Setting up' : exposure.label}
      </span>

      {/* Neutral unless the app is in trouble: the status column carries
          state, and a coloured line on every healthy app would make the one
          red line harder to find, not easier. */}
      <span className={cn(MID, 'flex min-w-0 items-center gap-2.5')}>
        <Spark
          values={row.status.spark}
          tone={row.status.state === 'attention' ? 'bad' : 'muted'}
          width={56}
          height={16}
        />
        <span className={cn(QUIET, 'ml-auto whitespace-nowrap')}>
          {row.status.rpm === null ? '—' : `${row.status.rpm.toFixed(1)}/min`}
        </span>
      </span>

      <span className={cn(QUIET, WIDE)} title={row.deployed?.digest}>
        {row.deployed === null ? (
          '—'
        ) : row.deployed.result === 'failed' ? (
          <span className="text-danger">
            failed <Ago at={row.deployed.at} />
          </span>
        ) : (
          <Ago at={row.deployed.at} />
        )}
      </span>

      <Status state={row.status.state} />
    </li>
  )
}

export function ExternalRow({ entry }: { entry: ExternalEntry }) {
  // The name stretches to the detail page; the address, the repo link and
  // the clone button sit above that link (`relative z-10`), each its own
  // click. The dot is the platform's own word on the last publish — nothing
  // on this box probes these sites.
  return (
    <li className={cn(SITE_GRID, ROW)}>
      <Identity
        icon={<AppIcon name={entry.id} hasIcon={entry.hasIcon} size={32} />}
        desc={entry.description}
        link={
          <Link to="/apps/offbox/$id" params={{ id: entry.id }} className={cn(STRETCH, 'truncate')}>
            {entry.name}
          </Link>
        }
        badges={entry.warnings.map((w) => (
          <Chip key={w} tone="warn" className={CHIP}>
            {w}
          </Chip>
        ))}
      />

      <a
        className={cn(MONO_CELL, MID, 'relative z-10 hover:text-foreground')}
        href={`https://${entry.host}`}
        target="_blank"
        rel="noreferrer"
      >
        {entry.host}
      </a>

      <span className={cn(WIDE, 'relative z-10 flex min-w-0 items-center gap-2')}>
        {entry.repo === null ? (
          <span className={QUIET}>—</span>
        ) : (
          <>
            <a
              className={cn(MONO_CELL, 'min-w-0 flex-1 hover:text-foreground')}
              href={`https://github.com/${entry.repo}`}
              target="_blank"
              rel="noreferrer"
              title={
                entry.workspace
                  ? `cloned — ${entry.workspace.branch ?? '?'} @ ${entry.workspace.head ?? '?'}${entry.workspace.dirty ? ', uncommitted changes' : ''}`
                  : 'not cloned on this box'
              }
            >
              {entry.repo}
            </a>
            <CloneButton repo={entry.repo} cloned={entry.workspace !== null} />
          </>
        )}
      </span>

      <span className={cn(QUIET, WIDE)} title={entry.deployed?.sha ?? undefined}>
        {entry.deployed === null ? '—' : <Ago at={entry.deployed.at} />}
      </span>

      <Status state={SITE_DOT[entry.state]} label={entry.state === 'live' ? 'Live' : undefined} />
    </li>
  )
}
