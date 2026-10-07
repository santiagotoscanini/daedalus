import { Ago } from '../../../components/ago'
import { CELL_QUIET, TABLE, TABLE_HEAD, TABLE_ROW, TableGroup } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Stat, StatStrip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { ActionsData } from '../data'
import { accessTone, accessWord, Ext, imageWord, RunChip, took } from './shared'

type Workflows = Extract<ActionsData, { tab: 'workflows' }>

const triggerWord = (t: string): string =>
  t === 'pull_request'
    ? 'pull request'
    : t === 'workflow_dispatch'
      ? 'by hand'
      : t.replace(/_/g, ' ')

export function WorkflowsView({ d }: { d: Workflows }) {
  const t = d.totals
  const hosted = t.images.linux + t.images.windows + t.images.macos + t.images.unknown

  return (
    <>
      <StatStrip>
        <Stat
          label="workflows"
          value={num(t.workflows)}
          sub={`${num(d.repos.length)} repositories`}
        />
        <Stat label="on push" value={num(t.onPush)} />
        <Stat label="on pull request" value={num(t.onPullRequest)} />
        <Stat label="scheduled" value={num(t.scheduled)} />
        <Stat label="run by hand" value={num(t.dispatchable)} />
        <Stat
          label="jobs on GitHub's machines"
          value={num(hosted)}
          sub={t.selfHosted > 0 ? `${num(t.selfHosted)} self-hosted` : 'none self-hosted'}
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Where jobs ask to run" icon="grid" span={4}>
          <BarList
            items={[
              { label: 'Linux', value: t.images.linux },
              { label: 'Windows', value: t.images.windows },
              { label: 'macOS', value: t.images.macos },
              { label: 'self-hosted', value: t.selfHosted, tone: 'info' as const },
            ].filter((i) => i.value > 0)}
            empty="no runs-on read"
          />
          <p className={FOOT}>
            Every <span className={MONO}>runs-on</span> in every file, a matrix counted once per
            image. This is the demand the Runners tab holds this network's machines against.
          </p>
        </Board>

        <Board title="Actions used" icon="rows" span={8}>
          <BarList
            items={t.actions.slice(0, 10).map((a) => ({ label: a.label, value: a.value }))}
            empty="no uses read"
          />
          <p className={FOOT}>
            Third-party code every run executes. A pinned sha is the safe form; a floating major is
            the common one.
          </p>
        </Board>

        <WorkflowsTable repos={d.repos} />
      </BoardGrid>
    </>
  )
}

/** State · workflow · runs · failed · median · last. The tallies step away first. */
const WF_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[6.5rem_minmax(14rem,1fr)_3.5rem_3.5rem_4.5rem_6rem] @max-[46rem]/table:grid-cols-[6.5rem_minmax(10rem,1fr)_6rem] @max-[46rem]/table:[&>.tally]:hidden'

/** What the box could read of a repository, said only where it is not the App. */
function readNote(r: Workflows['repos'][number]): string {
  const files = r.access.files
  const runs = r.access.runs
  if (files === 'app' && runs === 'app') return `${r.kind} · read as the App`
  if (files === runs) return `${r.kind} · ${accessWord(runs)}`
  return `${r.kind} · files ${accessWord(files)} · runs ${accessWord(runs)}`
}

/**
 * Every workflow file of every repository, one table grouped by repository.
 * A repository with no workflow file is not a group of its own: they share
 * one quiet row at the foot, since "nothing here" said thirteen times is a
 * page of empty boards.
 */
function WorkflowsTable({ repos }: { repos: Workflows['repos'] }) {
  const withFiles = repos.filter((r) => r.workflows.length > 0)
  const without = repos.filter((r) => r.workflows.length === 0)
  const listed = without.filter((r) => r.access.files === 'app' || r.access.files === 'public')
  const unlisted = without.filter((r) => !(r.access.files === 'app' || r.access.files === 'public'))
  return (
    <TableSection
      title="Every workflow"
      aside={`${num(repos.reduce((n, r) => n + r.workflows.length, 0))} files in ${num(withFiles.length)} repositories`}
    >
      <ul className={TABLE} aria-label="Workflows by repository">
        <li className={cn(WF_GRID, TABLE_HEAD)}>
          <span>Last run</span>
          <span>Workflow</span>
          <span className="tally text-right">Runs</span>
          <span className="tally text-right">Failed</span>
          <span className="tally text-right">Median</span>
          <span className="text-right">Last</span>
        </li>
        {withFiles.map((r) => (
          <RepoGroup key={r.repo} r={r} />
        ))}
        {listed.length > 0 && (
          <>
            <TableGroup title="No workflow files" note={`${String(listed.length)} repositories`} />
            <li className={cn(TABLE_ROW, 'flex flex-wrap items-center gap-x-4 gap-y-1 px-5')}>
              {listed.map((r) => (
                <span key={r.repo} title={readNote(r)}>
                  <Ext href={`${r.url}/actions`} className="text-[0.8rem] text-subdued">
                    {r.repo}
                  </Ext>
                  <span className="ml-1 text-[0.72rem] text-muted-foreground">{r.kind}</span>
                </span>
              ))}
            </li>
          </>
        )}
        {unlisted.length > 0 && (
          <>
            <TableGroup
              title="Could not list the files"
              note={`${String(unlisted.length)} repositories`}
            />
            {unlisted.map((r) => (
              <li key={r.repo} className={cn(TABLE_ROW, 'flex items-center gap-3 px-5')}>
                <Ext href={`${r.url}/actions`} className="text-foreground">
                  {r.repo}
                </Ext>
                <Chip tone={accessTone(r.access.files)}>{accessWord(r.access.files)}</Chip>
              </li>
            ))}
          </>
        )}
      </ul>
      <p className={FOOT}>
        Files come through <span className={MONO}>contents: read</span>, which the App has had since
        it was made; runs need <span className={MONO}>actions: read</span>. Each repository's line
        says how it was read; only a repository read some other way than as the App says so with a
        mark.
      </p>
    </TableSection>
  )
}

function RepoGroup({ r }: { r: Workflows['repos'][number] }) {
  return (
    <>
      <TableGroup
        title={
          <Ext href={`${r.url}/actions`} className="text-foreground">
            {r.repo}
          </Ext>
        }
        note={`${num(r.workflows.length)} workflow${r.workflows.length === 1 ? '' : 's'} · ${readNote(r)}`}
        aside={
          r.access.runs !== 'app' ? (
            <Chip tone={accessTone(r.access.runs)}>runs: {accessWord(r.access.runs)}</Chip>
          ) : undefined
        }
      />
      {r.workflows.map((w) => (
        <li key={w.id} className={cn(WF_GRID, TABLE_ROW, 'py-2.5')}>
          <span>
            {w.lastRun !== null ? (
              <RunChip status={w.lastRun.status} conclusion={w.lastRun.conclusion} />
            ) : (
              <span className="text-[0.75rem] text-muted-foreground">
                {w.state === 'unknown' ? 'no run read' : w.state.replace(/_/g, ' ')}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-baseline gap-2">
              <Ext href={w.url} className="truncate text-foreground [font-weight:560]">
                {w.name}
              </Ext>
              <span className={cn(MONO, 'truncate text-muted-foreground')}>
                {w.path.replace(/^\.github\/workflows\//, '')}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0 text-[0.75rem] text-muted-foreground">
              <span>
                on {w.triggers.length === 0 ? 'unknown' : w.triggers.map(triggerWord).join(', ')}
                {w.schedules.length > 0 && ` (${w.schedules.join('; ')})`}
              </span>
              <span>
                {num(w.jobs)} {w.jobs === 1 ? 'job' : 'jobs'}
                {w.runsOn.length > 0 && ` on ${[...new Set(w.runsOn.map(imageWord))].join(', ')}`}
              </span>
              {w.uses.length > 0 && (
                <span className="min-w-0 basis-full truncate" title={w.uses.join(', ')}>
                  uses {w.uses.join(', ')}
                </span>
              )}
            </span>
          </span>
          <span className={cn(CELL_QUIET, 'tally text-right')}>
            {w.runs > 0 ? num(w.runs) : DASH}
          </span>
          <span
            className={cn(
              'tally text-right tabular-nums',
              w.failed > 0 ? 'text-danger [font-weight:560]' : CELL_QUIET,
            )}
          >
            {w.failed > 0 ? num(w.failed) : DASH}
          </span>
          <span className={cn(CELL_QUIET, 'tally text-right')}>
            {w.runs > 0 ? took(w.p50) : DASH}
          </span>
          <span className={cn(CELL_QUIET, 'text-right')}>
            {w.lastRun !== null ? <Ago at={w.lastRun.at} /> : DASH}
          </span>
        </li>
      ))}
    </>
  )
}
