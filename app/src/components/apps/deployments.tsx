import { useState } from 'react'
import { rollUp } from '../../lib/activity-lines'
import { cn } from '../../lib/cn'
import { ms } from '../../lib/format'
import type { AppTabData } from '../../server/registry'
import { When } from '../ago'
import {
  CELL_MONO,
  CELL_QUIET,
  SECTION_NOTE,
  SECTION_TITLE,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
  TableMore,
} from '../table'
import { EMPTY, FOOT } from '../tokens'
import { Board, BoardGrid, Chip } from '../viz'
import { BuildsBoard } from './builds'
import { type AppRecord, CHIP, LEDE } from './shared'

type ActivityData = Extract<AppTabData, { kind: 'deployments' }>['activity']
type DeployRow = Extract<AppTabData, { kind: 'deployments' }>['deployments'][number]

/** Revision · result · when · took · digest · HTTP · commit. The numbers and
    the digest step away first; revision, result and when never do. */
const DEPLOY_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(7rem,1fr)_6rem_minmax(0,1.5fr)_3.5rem_7rem_3.5rem_9.5rem]',
  '@max-[60rem]/table:grid-cols-[minmax(7rem,1fr)_6rem_minmax(0,1.5fr)_7rem]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_6rem]',
)
/** Deploys shown before the list folds: the recent ones are what is read. */
const DEPLOYS_FOLDED = 10
const WIDE = '@max-[60rem]/table:hidden'
const NARROW = '@max-[40rem]/table:hidden'

export function Deployments({
  app,
  td,
}: {
  app: AppRecord
  td: Extract<AppTabData, { kind: 'deployments' }>
}) {
  const local = app.sourceMode === 'local'
  const [showAll, setShowAll] = useState(false)
  return (
    <>
      {/* Where the source is lives in the head above; what this tab adds for a
          local-source app is that there is nothing to deploy. */}
      {local && (
        <p className={cn(LEDE, 'mt-0 mb-6')}>
          Source is live from <code>stacks/{app.name}/app</code>, so there is nothing to build or
          deploy.
        </p>
      )}

      {!local && (
        <BuildsBoard
          app={app.name}
          initial={td.builds}
          buildOnBox={app.buildOnBox}
          linked={app.githubRepoId !== null}
        />
      )}

      <h2 className={cn(SECTION_TITLE, local && 'mt-0')}>Deploys</h2>
      <p className={SECTION_NOTE}>Only the runs where the image digest actually moved.</p>
      {td.deployments.length === 0 ? (
        <p className={cn(LEDE, 'mt-0')}>
          {local
            ? 'Local-source apps have no deploy history. The running code is the working tree.'
            : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
        </p>
      ) : (
        <ul className={TABLE} aria-label="Deploy history">
          <li className={cn(DEPLOY_GRID, TABLE_HEAD)}>
            <span>Revision</span>
            <span>Result</span>
            <span className={NARROW}>Deployed</span>
            <span className={cn('text-right', WIDE)}>Took</span>
            <span className={WIDE}>Digest</span>
            <span className={cn('text-right', WIDE)}>HTTP</span>
            <span className={cn('text-right', NARROW)}>Source</span>
          </li>
          {(showAll ? td.deployments : td.deployments.slice(0, DEPLOYS_FOLDED)).map((d) => (
            <DeployLine key={d.id} d={d} />
          ))}
          {td.deployments.length > DEPLOYS_FOLDED && (
            <TableMore
              open={showAll}
              onToggle={() => {
                setShowAll((v) => !v)
              }}
              more={`Show all ${String(td.deployments.length)} deploys`}
              less="Show the latest only"
            />
          )}
        </ul>
      )}

      {!local && <Activity activity={td.activity} />}
    </>
  )
}

/** One deploy. The current one is the row with ink; a success is the norm and
    reads quiet; a failure is loud. */
function DeployLine({ d }: { d: DeployRow }) {
  return (
    <li className={cn(DEPLOY_GRID, TABLE_ROW, d.isCurrent && 'bg-foreground/[0.025]')}>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2.5">
          <code
            className={cn(
              'truncate text-[0.8rem]',
              d.isCurrent ? 'text-foreground [font-weight:600]' : 'text-subdued',
            )}
          >
            {d.shortRevision ?? d.digest.slice(0, 12)}
          </code>
          {d.isCurrent && <Chip className={CHIP}>current</Chip>}
        </span>
        {/* On a phone the hidden columns live here, under the revision. */}
        <span className="mt-0.5 hidden text-[0.75rem] text-muted-foreground @max-[40rem]/table:block">
          <span className="whitespace-nowrap">
            <When at={d.startedAt} />
          </span>{' '}
          <span className="whitespace-nowrap">· {ms(d.durationMs)}</span>
          {d.commitUrl ? (
            <a
              href={d.commitUrl}
              target="_blank"
              rel="noreferrer"
              className="relative z-10 block whitespace-nowrap"
            >
              view commit ↗
            </a>
          ) : null}
        </span>
      </span>
      <span>
        {d.result === 'ok' ? (
          <span className="text-[0.78rem] text-muted-foreground">success</span>
        ) : (
          <Chip tone="bad" className={CHIP}>
            failed
          </Chip>
        )}
      </span>
      <span className={cn(CELL_QUIET, 'truncate', NARROW)}>
        <When at={d.startedAt} />
      </span>
      <span className={cn(CELL_QUIET, 'text-right', WIDE)}>{ms(d.durationMs)}</span>
      <code className={cn(CELL_MONO, WIDE)}>{d.digest.slice(0, 12)}</code>
      <span
        className={cn(
          CELL_QUIET,
          'text-right',
          WIDE,
          d.httpCode !== null && !d.httpCode.startsWith('2') && 'text-danger',
        )}
      >
        {d.httpCode ?? '—'}
      </span>
      <span className={cn('min-w-0 truncate text-right text-[0.78rem]', NARROW)}>
        {d.commitUrl ? (
          <a
            href={d.commitUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            view commit ↗
          </a>
        ) : (
          <span className="text-muted-foreground/70">
            {d.shortRevision ? 'no source link' : 'image labels unavailable'}
          </span>
        )}
      </span>
    </li>
  )
}

/**
 * The deploy journal, folded.
 *
 * Deploys only — builds are rows with their own page (the Builds table above)
 * — so this is the deploy unit's own journal (deploy.sh's account of pull,
 * restart and health-check), the last 6 hours of it from Loki.
 */
/** A raw 64-hex digest is unreadable and wraps ten lines on a phone: the first
    12 characters name it, and the row's title carries the whole line. */
const shortDigests = (line: string) =>
  line.replace(/(sha256:)?([0-9a-f]{64})/g, (_m, _p: string | undefined, h: string) =>
    h.slice(0, 12),
  )

function Activity({ activity }: { activity: ActivityData }) {
  const rolled = rollUp(activity)

  return (
    <div className="mt-10">
      <BoardGrid>
        <Board
          title="Deploy activity"
          icon="logs"
          span={12}
          aside={<span className="text-[0.75rem] text-muted-foreground">last 6 hours</span>}
        >
          {rolled.length === 0 ? (
            <p className={EMPTY}>Nothing in the last 6 hours.</p>
          ) : (
            // Scrolls inside its own bordered box, and takes no negative margins
            // to bleed to the board's edges: a caption follows it, and margins
            // that pulled outward would pull that caption up over the last rows.
            <div className="max-h-80 overflow-auto overscroll-contain rounded-xl border border-hairline bg-foreground/[0.03] font-mono text-[0.75rem]">
              {rolled.map((l) => (
                <div
                  key={l.key}
                  className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-2 border-hairline border-t py-1 pr-2 pl-3 first:border-t-0 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:gap-3"
                >
                  {/* Already formatted by the server — see ActivityRow. */}
                  <time className="whitespace-nowrap text-muted-foreground" dateTime={l.ts}>
                    {l.at}
                  </time>
                  <span className="min-w-0 text-subdued [overflow-wrap:anywhere]" title={l.line}>
                    {shortDigests(l.line)}
                  </span>
                  {l.count > 1 && (
                    // The repeat count for a folded run. Right-aligned in its own
                    // column so the messages stay on one left edge.
                    <span
                      className="rounded-[5px] bg-foreground/[0.06] px-1 tabular-nums whitespace-nowrap text-muted-foreground"
                      title={`Repeated ${String(l.count)} times, most recently at ${l.lastAt}`}
                    >
                      ×{l.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className={FOOT}>
            The deploy timer's own journal: pull, restart, health-check. It logs the same “no
            change” verdict every two minutes, so runs of it are folded into one row with a count.
          </p>
        </Board>
      </BoardGrid>
    </div>
  )
}
