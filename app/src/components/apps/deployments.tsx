import { rollUp } from '../../lib/activity-lines'
import { cn } from '../../lib/cn'
import { logTime, ms, when } from '../../lib/format'
import { OWNER } from '../../lib/site'
import { toneStyle } from '../../lib/tone'
import type { AppTabData } from '../../server/registry'
import { Badge } from '../ui/badge'
import { Board, BoardGrid } from '../viz'
import { BuildsBoard } from './builds'
import {
  type AppRecord,
  BOARD_FOOT,
  CHIP,
  LEDE,
  SECTION_HEAD,
  SECTION_HEAD_SMALL,
  VIZ_EMPTY,
} from './shared'

type ActivityData = Extract<AppTabData, { kind: 'deployments' }>['activity']

export function Deployments({
  app,
  td,
}: {
  app: AppRecord
  td: Extract<AppTabData, { kind: 'deployments' }>
}) {
  return (
    <>
      {/* Three items of very different widths — a repo link, a sentence, a
          button. Without wrapping, flex's default `flex-shrink: 1` squeezes
          each of them below its content instead, which is what broke the glyph
          away from the repo name onto its own line. `shrink-0` on the children
          makes them wrap as whole units. */}
      <p className="mt-0 mr-0 mb-[1.2rem] ml-0 flex flex-wrap items-center gap-x-[1.1rem] gap-y-[0.6rem] font-mono text-[0.82rem] [&>*]:shrink-0">
        {app.sourceMode === 'local' ? (
          <>
            <span className="text-(--text-muted)">⎇ stacks/{app.name}/app</span>
            <span className="text-(--text-muted)">source is live, nothing to deploy</span>
          </>
        ) : (
          <>
            <a href={`https://github.com/${OWNER}/${app.name}`} target="_blank" rel="noreferrer">
              ⎇ {OWNER}/{app.name}
            </a>
            <span className="text-(--text-muted)">
              {app.buildOnBox ? 'builds run on this box' : 'box builds are off for this app'}
            </span>
          </>
        )}
      </p>

      {app.sourceMode !== 'local' && (
        <div className="mb-[0.8rem]">
          <BoardGrid>
            <BuildsBoard
              app={app.name}
              initial={td.builds}
              buildOnBox={app.buildOnBox}
              linked={app.githubRepoId !== null}
            />
          </BoardGrid>
        </div>
      )}

      {app.sourceMode !== 'local' && <Activity activity={td.activity} />}

      {td.deployments.length === 0 ? (
        <p className={LEDE}>
          {app.sourceMode === 'local'
            ? 'Local-source apps have no deploy history. The running code is the working tree.'
            : 'No deploys recorded yet. History starts from the first deploy where the image digest actually moved.'}
        </p>
      ) : (
        <>
          <h2 className={SECTION_HEAD}>
            Deploy history
            <small className={SECTION_HEAD_SMALL}>
              only the runs where the digest actually moved
            </small>
          </h2>
          {/* The rail is the list's own ::before, inset top and bottom so it
              starts and ends at the first and last node rather than running
              past them. */}
          <ol className="relative m-0 list-none p-0 pl-6 before:absolute before:top-3 before:bottom-3 before:left-[5px] before:w-px before:bg-border before:content-['']">
            {td.deployments.map((d) => (
              <li key={d.id} className="relative mb-[0.6rem]">
                <span
                  className={cn(
                    'absolute top-[1.15rem] -left-6 size-[11px] rounded-full border-2 border-background bg-background shadow-[0_0_0_1.5px_var(--tone)]',
                    d.isCurrent && 'bg-(--tone)',
                  )}
                  style={toneStyle(
                    d.isCurrent
                      ? 'accent'
                      : d.result === 'ok'
                        ? 'ok'
                        : d.result === 'failed'
                          ? 'bad'
                          : 'muted',
                  )}
                />
                <div
                  className={cn(
                    'rounded-lg border border-(--border-soft) bg-(--panel) px-[1.05rem] py-[0.8rem]',
                    d.isCurrent &&
                      'border-primary/40 bg-[color-mix(in_srgb,var(--brand)_6%,var(--panel))]',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-[0.85rem] gap-y-[0.4rem]">
                    <code className="text-[0.95rem] font-semibold">
                      {d.shortRevision ?? d.digest.slice(0, 12)}
                    </code>
                    {d.isCurrent ? (
                      <Badge variant="warning" className={cn(CHIP, 'ml-auto')}>
                        current
                      </Badge>
                    ) : d.result === 'ok' ? (
                      <Badge variant="success" className={cn(CHIP, 'ml-auto')}>
                        success
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={cn(CHIP, 'ml-auto border-danger/45 text-danger')}
                      >
                        failed
                      </Badge>
                    )}
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer">
                        view commit ↗
                      </a>
                    ) : (
                      <span className="text-(--text-muted)">
                        {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                      </span>
                    )}
                  </div>
                  <div className="mt-[0.4rem] flex flex-wrap gap-[1.1rem] text-[0.78rem] text-(--dim)">
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

/**
 * The deploy journal, folded.
 *
 * Deploys only: the build half is not a log stream any more — builds run on
 * this box and are rows with their own page (BuildsBoard above), so what is
 * left here is deploy.sh's own account of pull, restart and health-check.
 */
function Activity({ activity }: { activity: ActivityData }) {
  const rolled = rollUp(activity)

  return (
    <BoardGrid>
      <Board
        title="Deploy activity"
        icon="logs"
        span={12}
        aside={<span className="text-[0.73rem] text-(--dim)">last 6 hours</span>}
      >
        {rolled.length === 0 ? (
          <p className={VIZ_EMPTY}>Nothing in the last 6 hours.</p>
        ) : (
          // Scrolls inside its own bordered box, and takes no negative margins
          // to bleed to the board's edges: a caption follows it, and margins
          // that pulled outward would pull that caption up over the last rows.
          <div className="max-h-80 overflow-auto overscroll-contain rounded-[9px] border border-(--border-soft) bg-background font-mono text-[0.75rem]">
            {rolled.map((l) => (
              <div
                key={l.key}
                className="grid grid-cols-[6.5rem_1fr_auto] items-baseline gap-[0.7rem] border-t border-t-(--border-soft) px-[0.7rem] py-[0.26rem] first:border-t-0"
              >
                <time className="whitespace-nowrap text-(--dim)">{logTime(l.ts)}</time>
                <span className="min-w-0 text-(--text-muted) [overflow-wrap:anywhere]">
                  {l.line}
                </span>
                {l.count > 1 && (
                  // The repeat count for a folded run. Right-aligned in its own
                  // column so the messages stay on one left edge.
                  <span
                    className="rounded-[5px] bg-(--panel-2) px-1 tabular-nums whitespace-nowrap text-(--dim)"
                    title={`Repeated ${String(l.count)} times, most recently at ${logTime(l.lastTs)}`}
                  >
                    ×{l.count}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <p className={BOARD_FOOT}>
          The deploy timer's own journal: pull, restart, health-check. It logs the same “no change”
          verdict every two minutes, so runs of it are folded into one row with a count.
        </p>
      </Board>
    </BoardGrid>
  )
}
