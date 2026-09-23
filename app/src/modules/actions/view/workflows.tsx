import { FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Stat, StatStrip } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { ActionsData } from '../data'
import { accessTone, accessWord, ago, Ext, imageWord, RunChip, took } from './shared'

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

        <Board title="Actions used" icon="rows" span={4}>
          <BarList
            items={t.actions.slice(0, 10).map((a) => ({ label: a.label, value: a.value }))}
            empty="no uses read"
          />
          <p className={FOOT}>
            Third-party code every run executes. A pinned sha is the safe form; a floating major is
            the common one.
          </p>
        </Board>

        <Board title="What the box read" icon="panels" span={4}>
          <ul className={LIST}>
            {d.repos.map((r) => (
              <li key={r.repo} className={ROW}>
                <span className={ROW_MAIN}>{r.repo}</span>
                <span className={ROW_SIDE}>
                  <Chip tone={accessTone(r.access.files)}>files</Chip>{' '}
                  <Chip tone={accessTone(r.access.runs)}>runs</Chip>
                </span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            Files come through <span className={MONO}>contents: read</span>, which the App has had
            since it was made; runs need <span className={MONO}>actions: read</span>. Green is the
            App, blue is what anyone can read, amber is the permission not yet granted.
          </p>
        </Board>

        {d.repos.map((r) => (
          <Board
            key={r.repo}
            title={r.repo}
            icon="logs"
            span={12}
            aside={
              <span className={NOTE}>
                <Ext href={`${r.url}/actions`} className="text-primary">
                  {num(r.workflows.length)} workflows
                </Ext>
                {' · '}
                {r.kind} · {accessWord(r.access.runs)}
              </span>
            }
          >
            {r.workflows.length === 0 ? (
              <p className={FOOT}>
                {r.access.files === 'app' || r.access.files === 'public'
                  ? 'No workflow files.'
                  : `Could not list the files: ${accessWord(r.access.files)}.`}
              </p>
            ) : (
              <ul className={LIST}>
                {r.workflows.map((w) => (
                  <li
                    key={w.id}
                    className="border-(--border-soft) border-t py-[0.45rem] first:border-t-0"
                  >
                    <div className="flex min-w-0 items-center gap-[0.45rem] text-[0.77rem]">
                      {w.lastRun !== null ? (
                        <RunChip status={w.lastRun.status} conclusion={w.lastRun.conclusion} />
                      ) : (
                        <Chip tone="muted">
                          {w.state === 'unknown' ? 'no run read' : w.state.replace(/_/g, ' ')}
                        </Chip>
                      )}
                      <span className={ROW_MAIN}>
                        <Ext href={w.url}>
                          <b className="font-[550]">{w.name}</b>
                        </Ext>
                        <span className={`ml-[0.4rem] ${MONO} text-muted-foreground`}>
                          {w.path.replace(/^\.github\/workflows\//, '')}
                        </span>
                      </span>
                      <span className={ROW_SIDE}>
                        {w.runs > 0 && (
                          <>
                            {num(w.runs)} runs
                            {w.failed > 0 && (
                              <span className="text-(--tone-bad)"> · {num(w.failed)} failed</span>
                            )}
                            {' · median '}
                            {took(w.p50)}
                            {w.lastRun !== null && ` · last ${ago(w.lastRun.at)}`}
                          </>
                        )}
                      </span>
                    </div>
                    <p
                      className={`${SUB} mt-[0.2rem] flex flex-wrap gap-x-[0.9rem] gap-y-[0.1rem] font-normal`}
                    >
                      <span>
                        on{' '}
                        {w.triggers.length === 0
                          ? 'unknown'
                          : w.triggers.map(triggerWord).join(', ')}
                        {w.schedules.length > 0 && ` (${w.schedules.join('; ')})`}
                      </span>
                      <span>
                        {num(w.jobs)} {w.jobs === 1 ? 'job' : 'jobs'}
                        {w.runsOn.length > 0 &&
                          ` on ${[...new Set(w.runsOn.map(imageWord))].join(', ')}`}
                      </span>
                      {w.uses.length > 0 && <span>uses {w.uses.join(', ')}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Board>
        ))}
      </BoardGrid>
    </>
  )
}
