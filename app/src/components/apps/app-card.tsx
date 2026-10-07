// One card in the apps list: an app on the box, or a project that is not.
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { Platform, SiteState } from '../../lib/external-apps'
import { type AppStage, isAppStage } from '../../lib/stage'
import type { Tone } from '../../lib/tone'
import { Ago } from '../ago'
import { AppIcon, type AppState, StateDot } from '../controls'
import { Chip, Spark } from '../viz'
import { GLASS } from '../viz/board'
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

export function ExternalRow({ entry }: { entry: ExternalEntry }) {
  // The card is the link to the site's detail page; the actions live BESIDE
  // it, not inside — a button in an anchor is one click with two meanings,
  // and invalid HTML besides. The foot carries the site itself, the repo,
  // and the one workspace action these projects have. The dot is the
  // platform's own word on the last publish (nothing on this box probes
  // these sites), so there is no spark.
  return (
    <li className={cn(CARD, CARD_ASIDE)}>
      <Link to="/apps/offbox/$id" params={{ id: entry.id }} className={CARD_LINK}>
        <div className={CARD_HEAD}>
          <span className={CARD_ICON}>
            <AppIcon name={entry.id} hasIcon={entry.hasIcon} size={36} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={APP_NAME}>
              {entry.name}
              <StateDot state={SITE_DOT[entry.state]} label={entry.state} />
            </div>
            <code className={APP_HOST}>{entry.host}</code>
          </div>
        </div>
        {entry.description !== null && <p className={APP_DESC}>{entry.description}</p>}
        <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.75rem] text-muted-foreground">
          {entry.deployed !== null && (
            <span>
              deployed <Ago at={entry.deployed.at} />
              {entry.deployed.sha !== null && <code> · {entry.deployed.sha.slice(0, 7)}</code>}
            </span>
          )}
          {entry.warnings.map((w) => (
            <Chip key={w} tone="warn" className={CHIP}>
              {w}
            </Chip>
          ))}
        </div>
      </Link>
      <div className="flex min-w-0 items-center justify-between gap-3 border-hairline border-t px-4 py-2.5 text-[0.8rem]">
        <a
          className="shrink-0 text-subdued"
          href={`https://${entry.host}`}
          target="_blank"
          rel="noreferrer"
        >
          ↗ site
        </a>
        {entry.repo !== null && (
          <>
            <a
              className="min-w-0 flex-1 truncate text-subdued"
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
            <CloneButton repo={entry.repo} cloned={entry.workspace !== null} />
          </>
        )}
      </div>
    </li>
  )
}

export const CARD = cn(
  GLASS,
  'flex min-w-0 flex-col transition-[background-color,border-color,translate] duration-150 hover:-translate-y-px hover:border-foreground/15 hover:bg-surface-hover motion-reduce:hover:translate-y-0',
)

/** Off-box and control-plane cards: dashed, the visual for "listed here, not
    one of the things being managed". */
export const CARD_ASIDE = 'border-dashed bg-transparent shadow-none'

/* The whole card is the link; the foot rides inside it so one hover means
   one destination. External cards keep their outbound links in a foot beside it (see ExternalRow). */
export const CARD_LINK =
  'flex min-w-0 flex-1 flex-col gap-3 px-4 pt-4 pb-4 text-inherit hover:no-underline'

export const CARD_HEAD = 'flex min-w-0 items-center gap-3'

/** AppIcon draws a 5px corner for its small uses; at card size it is clipped to the
    control radius so the icon reads as a tile, not a stamp. */
export const CARD_ICON = 'inline-flex flex-none overflow-hidden rounded-[10px]'

export const APP_NAME =
  'flex min-w-0 items-center gap-2 text-[0.9rem] [font-weight:560] text-foreground'

export const APP_HOST = 'block truncate font-mono text-[0.75rem] text-muted-foreground'

/** Two lines, then quiet: a card column where one long description makes one
    row twice as tall reads as a layout accident. */
export const APP_DESC = 'm-0 line-clamp-2 text-[0.8rem] leading-[1.5] text-subdued'

/** The spark sizes itself from its height and is pushed to the right edge. */
export const CARD_FOOT = 'mt-auto flex items-center gap-2.5 pt-0.5 [&>svg]:ml-auto'

/** The exposure chip, by stage — the label included, so the row has nothing
    left to decide. Neutral on every stage: where an app is reachable is a
    fact, not a verdict, and green beside the health dot read as a second
    "healthy". A new app's chip is dashed, the same
    visual the aside cards use for "listed here, not one of the things being
    run": it is where the app WILL run. */
export const STAGE_CHIP: Record<AppStage, { tone: Tone; className: string; label: string }> = {
  live: { tone: 'muted', className: CHIP, label: 'public' },
  lab: {
    tone: 'muted',
    className: CHIP,
    label: 'lab',
  },
  off: { tone: 'muted', className: CHIP, label: 'off' },
}

export function AppRow({ row, aside = false }: { row: Row; aside?: boolean }) {
  // The column is text, so a value the ladder does not know is possible in
  // principle; it reads as the platform's own default rather than as nothing.
  const stage = STAGE_CHIP[isAppStage(row.stage) ? row.stage : 'lab']
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
          <span className={CARD_ICON}>
            <AppIcon name={row.name} hasIcon={row.hasIcon} size={36} />
          </span>
          <div className="min-w-0 flex-1">
            <div className={APP_NAME}>
              {row.name}
              {row.managedInNix && (
                <Chip
                  tone="muted"
                  className={cn(CHIP, 'text-subdued')}
                  title="Declared by hand in Nix, read-only here"
                >
                  nix
                </Chip>
              )}
              {!row.managedInNix && row.drift.length > 0 && (
                <Chip tone="warn" className={CHIP} title={`Changed: ${row.drift.join(', ')}`}>
                  unapplied
                </Chip>
              )}
            </div>
            <code className={APP_HOST}>{row.hostname}</code>
          </div>
          <StateDot state={row.status.state} />
        </div>

        <p className={APP_DESC}>{row.description || '—'}</p>

        <div className={CARD_FOOT}>
          <Chip
            tone={row.isNew ? 'muted' : stage.tone}
            className={row.isNew ? cn(CHIP, 'border border-dashed ring-0') : stage.className}
            title={row.isNew ? 'Setting up: this is where it will run' : undefined}
          >
            {stage.label}
          </Chip>

          {/* Neutral unless the app is in trouble: the dot in the head
              already carries state, and a green line on every healthy app
              would make the one red line harder to find, not easier. */}
          <Spark
            values={row.status.spark}
            tone={row.status.state === 'attention' ? 'bad' : 'muted'}
            width={72}
            height={18}
          />
          <span className="text-[0.75rem] text-muted-foreground tabular-nums">
            {row.status.rpm === null ? '—' : `${row.status.rpm.toFixed(1)} rpm`}
          </span>
        </div>
      </Link>
    </li>
  )
}
