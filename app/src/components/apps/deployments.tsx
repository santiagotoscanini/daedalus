import { rollUp } from '../../lib/activity-lines'
import { cn } from '../../lib/cn'
import { ms } from '../../lib/format'
import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { toneStyle } from '../../lib/tone'
import type { AppTabData } from '../../server/registry'
import { When } from '../ago'
import { EMPTY, FOOT } from '../tokens'
import { Board, BoardGrid, Chip } from '../viz'
import { GLASS } from '../viz/board'
import { BuildsBoard } from './builds'
import { type AppRecord, CHIP, LEDE, SECTION_HEAD, SECTION_HEAD_SMALL } from './shared'

type ActivityData = Extract<AppTabData, { kind: 'deployments' }>['activity']

export function Deployments({
  app,
  td,
}: {
  app: AppRecord
  td: Extract<AppTabData, { kind: 'deployments' }>
}) {
  const repo = appRepo(useSite(), app.name)
  return (
    <>
      {/* Three items of very different widths — a repo link, a sentence, a
          button. Without wrapping, flex's default `flex-shrink: 1` squeezes
          each of them below its content instead, which is what broke the glyph
          away from the repo name onto its own line. `shrink-0` on the children
          makes them wrap as whole units. */}
      <p className="mt-0 mr-0 mb-5 ml-0 flex flex-wrap items-center gap-x-4 gap-y-2.5 font-mono text-[0.82rem] [&>*]:shrink-0">
        {app.sourceMode === 'local' ? (
          <>
            <span className="text-subdued">⎇ stacks/{app.name}/app</span>
            <span className="text-subdued">source is live, nothing to deploy</span>
          </>
        ) : (
          <>
            <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
              ⎇ {repo}
            </a>
            <span className="text-subdued">
              {app.buildOnBox ? 'builds run on this box' : 'box builds are off for this app'}
            </span>
          </>
        )}
      </p>

      {app.sourceMode !== 'local' && (
        <div className="mb-3">
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
          <ol className="relative m-0 list-none p-0 pl-6 before:absolute before:top-3 before:bottom-3 before:left-[5px] before:w-px before:bg-hairline before:content-['']">
            {td.deployments.map((d) => (
              <li key={d.id} className="relative mb-3">
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
                    GLASS,
                    'rounded-xl px-4 py-3',
                    d.isCurrent && 'border-foreground/15 bg-surface-hover',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
                    <code className="text-[0.9rem] font-[560]">
                      {d.shortRevision ?? d.digest.slice(0, 12)}
                    </code>
                    {d.isCurrent ? (
                      <Chip tone="warn" className={cn(CHIP, 'ml-auto')}>
                        current
                      </Chip>
                    ) : d.result === 'ok' ? (
                      <Chip tone="ok" className={cn(CHIP, 'ml-auto')}>
                        success
                      </Chip>
                    ) : (
                      <Chip tone="bad" className={cn(CHIP, 'ml-auto')}>
                        failed
                      </Chip>
                    )}
                    {d.commitUrl ? (
                      <a href={d.commitUrl} target="_blank" rel="noreferrer">
                        view commit ↗
                      </a>
                    ) : (
                      <span className="text-subdued">
                        {d.shortRevision ? 'no source link' : 'image labels unavailable'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted-foreground">
                    <span>{<When at={d.startedAt} />}</span>
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
 * Deploys only — builds are rows with their own page (BuildsBoard above) — so
 * this is the deploy unit's own journal (deploy.sh's account of pull, restart
 * and health-check), the last 6 hours of it from Loki.
 */
function Activity({ activity }: { activity: ActivityData }) {
  const rolled = rollUp(activity)

  return (
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
                className="grid grid-cols-[6.5rem_1fr_auto] items-baseline gap-3 border-hairline border-t px-3 py-1 first:border-t-0"
              >
                {/* Already formatted by the server — see ActivityRow. */}
                <time className="whitespace-nowrap text-muted-foreground" dateTime={l.ts}>
                  {l.at}
                </time>
                <span className="min-w-0 text-subdued [overflow-wrap:anywhere]">{l.line}</span>
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
          The deploy timer's own journal: pull, restart, health-check. It logs the same “no change”
          verdict every two minutes, so runs of it are folded into one row with a count.
        </p>
      </Board>
    </BoardGrid>
  )
}
