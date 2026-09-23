import { AXIS, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Columns, Stat, StatStrip } from '../../../components/viz'
import { DASH, duration, num, pct } from '../../../lib/format'
import type { ActionsData } from '../data'
import type { RunRow } from '../data/runs'
import { ago, Ext, GrantBoard, imageWord, RunChip, took } from './shared'

type Runs = Extract<ActionsData, { tab: 'runs' }>

function RunLine({ r, showFailure = false }: { r: RunRow; showFailure?: boolean }) {
  return (
    <li className={ROW}>
      <RunChip status={r.status} conclusion={r.conclusion} />
      <span className={ROW_MAIN}>
        <Ext href={r.url}>
          <b className="font-[550]">{r.repo}</b> · {r.workflow}
        </Ext>
        {r.branch !== null && r.branch !== 'main' && (
          <span className="ml-[0.4rem] text-muted-foreground">{r.branch}</span>
        )}
        {showFailure && r.failed !== null && (
          <span className="ml-[0.4rem] text-(--tone-bad)">
            {r.failed.job}
            {r.failed.step !== null && ` › ${r.failed.step}`}
          </span>
        )}
      </span>
      <span className={ROW_SIDE}>
        {r.event}
        {r.ranOn.length > 0 && ` · ${r.ranOn.map(imageWord).join(', ')}`} · {took(r.seconds)} ·{' '}
        {ago(r.createdAt)}
      </span>
    </li>
  )
}

export function RunsView({ d }: { d: Runs }) {
  const t = d.totals
  const okRate = t.runs === 0 ? null : (100 * t.ok) / Math.max(1, t.ok + t.failed)
  const first = d.days[0]?.label ?? ''
  const last = d.days[d.days.length - 1]?.label ?? ''

  return (
    <>
      <StatStrip>
        <Stat label={`runs · ${String(d.windowDays)} days`} value={num(t.runs)} />
        <Stat
          label="succeeded"
          value={okRate === null ? DASH : pct(okRate)}
          tone={okRate !== null && okRate < 80 ? 'warn' : undefined}
          sub={`${num(t.ok)} of ${num(t.ok + t.failed)} finished`}
        />
        <Stat label="failed" value={num(t.failed)} tone={t.failed > 0 ? 'bad' : undefined} />
        <Stat
          label="running now"
          value={num(t.running)}
          tone={t.running > 0 ? 'accent' : undefined}
          sub={t.queued > 0 ? `${num(t.queued)} queued` : undefined}
        />
        <Stat label="median run" value={took(t.p50)} sub={`p95 ${took(t.p95)}`} />
        <Stat
          label="repositories read"
          value={`${num(t.readable)} / ${num(t.watched)}`}
          tone={t.readable < t.watched ? 'warn' : undefined}
        />
      </StatStrip>

      <BoardGrid>
        <Board
          title="Runs per day"
          icon="clock"
          span={8}
          aside={<span className={NOTE}>a hairline marks a day with a failure</span>}
        >
          <Columns points={d.days} height={92} empty="no runs in the window" />
          <p className={AXIS}>
            <span>{first}</span>
            <span>runs</span>
            <span>{last}</span>
          </p>
        </Board>

        <Board title="By event" icon="rows" span={4}>
          <BarList
            items={d.byEvent.map((e) => ({ label: e.label.replace(/_/g, ' '), value: e.value }))}
            empty="nothing ran"
          />
          <p className={FOOT}>
            What starts a workflow: a push, a pull request, a schedule, a tag, or a hand on "Run
            workflow". The apps deploy through daedalus's own webhook and never appear here.
          </p>
        </Board>

        {d.running.length > 0 && (
          <Board
            title="Running now"
            icon="clock"
            span={12}
            aside={<Chip tone="accent">{String(d.running.length)} live</Chip>}
          >
            <ul className={LIST}>
              {d.running.map((r) => (
                <RunLine key={r.id} r={r} />
              ))}
            </ul>
          </Board>
        )}

        <GrantBoard unreadable={d.unreadable} publicRepos={d.publicRepos} budget={d.budget} />

        <Board
          title="Recent runs"
          icon="logs"
          span={12}
          aside={<span className={NOTE}>newest first · {num(d.recent.length)} shown</span>}
        >
          {d.recent.length === 0 ? (
            <p className={FOOT}>No run the box can read in the last {String(d.windowDays)} days.</p>
          ) : (
            <ul className={LIST}>
              {d.recent.map((r) => (
                <RunLine key={r.id} r={r} />
              ))}
            </ul>
          )}
        </Board>

        <Board
          title="Failures"
          icon="warn"
          span={6}
          aside={
            <Chip tone={d.failures.length > 0 ? 'bad' : 'ok'}>
              {d.failures.length === 0 ? 'none' : String(d.failures.length)}
            </Chip>
          }
        >
          {d.failures.length === 0 ? (
            <p className={FOOT}>Nothing failed in the window.</p>
          ) : (
            <ul className={LIST}>
              {d.failures.map((r) => (
                <RunLine key={r.id} r={r} showFailure />
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The job and the step that failed, read from the run's jobs; the link opens the run's log
            on GitHub.
          </p>
        </Board>

        <Board title="By workflow" icon="rows" span={6}>
          <ul className={LIST}>
            {d.byWorkflow.map((w) => (
              <li key={w.label} className={ROW}>
                <span className={ROW_MAIN}>{w.label}</span>
                <span className={ROW_SIDE}>
                  {num(w.runs)} runs
                  {w.failed > 0 && (
                    <span className="text-(--tone-bad)"> · {num(w.failed)} failed</span>
                  )}
                  {' · median '}
                  {took(w.p50)}
                </span>
              </li>
            ))}
            {d.byWorkflow.length === 0 && <li className={FOOT}>no runs</li>}
          </ul>
        </Board>

        <Board title="By repository" icon="grid" span={12}>
          <ul className={LIST}>
            {d.byRepo.map((r) => (
              <li key={r.repo} className={ROW}>
                <span className={ROW_MAIN}>
                  <Ext href={`${r.url}/actions`}>{r.repo}</Ext>
                  <span className="ml-[0.4rem] text-muted-foreground">{r.kind}</span>
                </span>
                <span className={ROW_SIDE}>
                  {r.access === 'app' || r.access === 'public' ? (
                    <>
                      {num(r.runs)} runs
                      {r.total > r.runs && ` of ${num(r.total)}`}
                      {r.failed > 0 && (
                        <span className="text-(--tone-bad)"> · {num(r.failed)} failed</span>
                      )}
                      {' · median '}
                      {r.p50 === null ? DASH : duration(r.p50)}
                      {r.access === 'public' && ' · public'}
                    </>
                  ) : (
                    <span className={MONO}>needs actions: read</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Board>
      </BoardGrid>
    </>
  )
}
