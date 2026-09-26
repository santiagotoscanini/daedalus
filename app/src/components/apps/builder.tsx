import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { BuilderData } from '../../lib/apps/builder'
import {
  buildDurationMs,
  buildTimeline,
  type LiveBuild,
  sha7,
  type TimelineStep,
} from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { bytes, DASH, ms, pct, since } from '../../lib/format'
import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { type Tone, toneStyle } from '../../lib/tone'
import { fetchBuilderNow } from '../../server/builds'
import { ImageRow } from '../image-row'
import { useNow, usePoll } from '../poll'
import {
  FOOT as BOARD_FOOT,
  NOTE as BOARD_NOTE,
  SUB as BOARD_SUB,
  LIST,
  MONO,
  ROW,
  ROW_MAIN,
  ROW_N,
  ROW_SIDE,
  EMPTY as VIZ_EMPTY,
} from '../tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Progress, Pulse, Stat, StatStrip } from '../viz'
import { BuildStateChip, requesterLabel } from './builds'

// Apps › Builder: the box's image builder, as one machine — what it is
// building now, how its builds have gone, what it is built from, the machinery
// under it and how GitHub reaches it. What it pushed is the Container registry
// tab beside this one. The loader (lib/apps/builder.ts) says where each
// section comes from.
//
// Only "Now" is live. It starts from the loader's rows and re-reads them in
// place — every 3 s while anything is queued or running, every 15 s while idle
// so a push that lands is picked up — and when a build leaves it, the page's
// data is re-read once so History and the stage medians take it in. The rest
// is a reading.
// is a reading, like every other tab here.

type Builder = BuilderData

const ago = (now: number | null, iso: string | null): string =>
  now === null || iso === null ? DASH : since((now - Date.parse(iso)) / 1000)

export function BuilderView({ d }: { d: Builder }) {
  const now = useNow(false)
  return (
    <BoardGrid>
      <NowBoard initial={d.now} />
      <HistoryBoard h={d.history} />
      <StagesBoard h={d.history} />
      <FailuresBoard h={d.history} now={now} />
      <ToolchainBoard d={d} />
      <MachineryBoard m={d.machinery} now={now} />
      <GithubBoard g={d.github} now={now} />
    </BoardGrid>
  )
}

/* ── now ──────────────────────────────────────────────────────────────── */

const STEP_TONE: Record<TimelineStep['status'], Tone> = {
  done: 'ok',
  running: 'info',
  failed: 'bad',
  pending: 'muted',
  skipped: 'muted',
}

function NowBoard({ initial }: { initial: LiveBuild[] }) {
  const router = useRouter()
  const [builds, setBuilds] = useState(initial)
  useEffect(() => {
    setBuilds(initial)
  }, [initial])

  const open = builds.length > 0
  const now = useNow(open)

  usePoll(
    async () => {
      const next = await fetchBuilderNow().catch(() => null)
      if (next === null) return
      const left = builds.some((b) => !next.some((n) => n.id === b.id))
      setBuilds(next)
      // A build finished: History and the medians are now one build out of date.
      if (left) void router.invalidate()
    },
    open ? 3000 : 15_000,
    true,
  )

  const running = builds.filter((b) => b.state !== 'queued').length
  return (
    <Board
      title="Now"
      icon="logs"
      span={12}
      aside={
        <span className={cn(BOARD_NOTE, 'inline-flex items-center gap-[0.35rem]')}>
          <Pulse on={running > 0} tone="info" />
          {running > 0
            ? `${String(running)} building, ${String(builds.length - running)} queued`
            : builds.length > 0
              ? `${String(builds.length)} queued`
              : 'idle'}
        </span>
      }
    >
      {builds.length === 0 ? (
        <p className={VIZ_EMPTY}>Nothing is queued or building.</p>
      ) : (
        <ul className={LIST}>
          {builds.map((b) => (
            <NowRow key={b.id} b={b} now={now} />
          ))}
        </ul>
      )}
      <p className={BOARD_FOOT}>
        One build runs at a time; a newer push replaces a build still waiting in its lane. A
        candidate build pushes <span className={MONO}>candidate-&lt;sha&gt;</span> and deploys
        nothing. What each build pushed is on the{' '}
        <Link to="/apps" search={{ tab: 'images' }}>
          Container registry
        </Link>{' '}
        tab.
      </p>
    </Board>
  )
}

function NowRow({ b, now }: { b: LiveBuild; now: number | null }) {
  const steps = buildTimeline(b.state, b.timings)
  // The host times a stage when it ends, so the running one has no number of
  // its own; the clock on the right is the whole build since its hand-off.
  const took = now === null ? null : buildDurationMs(b, now)
  return (
    <li className={cn(ROW, 'flex-wrap gap-y-[0.35rem] py-[0.5rem]')}>
      <Link
        to="/apps/$name/builds/$id"
        params={{ name: b.app, id: b.id }}
        className="inline-flex min-w-[11rem] items-baseline gap-[0.5rem] no-underline"
      >
        <span className="text-foreground">{b.app}</span>
        <code className="text-[0.74rem] text-(--dim)">{sha7(b.sha)}</code>
      </Link>
      <BuildStateChip state={b.state} />
      <span className={ROW_SIDE}>
        {requesterLabel(b)}
        {b.publish === 'candidate' && ' · candidate'}
      </span>
      <ol className="m-0 ml-auto flex list-none flex-wrap items-center gap-x-[0.8rem] gap-y-1 p-0">
        {steps.map((s) => (
          <li
            key={s.phase}
            className={cn(
              'inline-flex items-center gap-[0.3rem] text-[0.74rem]',
              s.status === 'pending' ? 'text-(--dim)' : 'text-(--text-muted)',
            )}
          >
            {s.status === 'running' ? (
              <Pulse on tone="info" />
            ) : (
              <span
                aria-hidden="true"
                className="inline-block size-[7px] flex-none rounded-full bg-(--tone)"
                style={toneStyle(STEP_TONE[s.status])}
              />
            )}
            {s.phase}
            <span className="font-mono text-[0.7rem] text-(--dim)">
              {s.ms === null ? '' : ms(s.ms)}
            </span>
          </li>
        ))}
      </ol>
      <span className={cn(ROW_N, 'min-w-[5.5rem] text-[0.72rem] text-(--dim)')}>
        {b.state === 'queued' ? `asked ${ago(now, b.createdAt)}` : ms(took)}
      </span>
    </li>
  )
}

/* ── history ──────────────────────────────────────────────────────────── */

type History = Builder['history']

function HistoryBoard({ h }: { h: History }) {
  return (
    <Board
      title="History"
      icon="logs"
      span={8}
      aside={<span className={BOARD_NOTE}>last {String(h.days)} days</span>}
    >
      <StatStrip>
        <Stat label="Builds" value={String(h.total)} />
        <Stat
          label="Landed"
          value={h.successRate === null ? DASH : pct(h.successRate * 100)}
          sub={`${String(h.succeeded)} of ${String(h.succeeded + h.failed)} · ${String(h.failed)} failed`}
        />
        <Stat label="Median build" value={ms(h.medianMs)} sub="hand-off to finish" />
      </StatStrip>
      {h.apps.length === 0 ? (
        <p className={VIZ_EMPTY}>No builds in this window.</p>
      ) : (
        <ul className={LIST}>
          {h.apps.map((a) => (
            <li key={a.app} className={ROW}>
              <Link
                to="/apps/$name"
                params={{ name: a.app }}
                search={{ tab: 'deployments' }}
                className={ROW_MAIN}
              >
                {a.app}
              </Link>
              <span className={ROW_SIDE}>
                {String(a.total)} build{a.total === 1 ? '' : 's'}
                {a.failed > 0 && `, ${String(a.failed)} failed`}
              </span>
              <span className={ROW_SIDE}>median {ms(a.medianMs)}</span>
              <span
                className={cn(
                  ROW_N,
                  'min-w-[3rem]',
                  a.successRate !== null && a.successRate < 1 && 'text-warning',
                )}
              >
                {a.successRate === null ? DASH : pct(a.successRate * 100)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={BOARD_FOOT}>
        “Landed” is succeeded over succeeded plus failed: a cancelled or superseded build was
        somebody’s decision, not the builder’s result. A build’s time runs from its hand-off to the
        host to its last word, so the wait in the queue is not in it.
      </p>
    </Board>
  )
}

function StagesBoard({ h }: { h: History }) {
  const items = h.stages
    .filter((s) => s.medianMs !== null)
    .map((s) => ({
      label: s.phase,
      value: s.medianMs ?? 0,
      display: `${ms(s.medianMs)} · ${String(s.count)}`,
    }))
  return (
    <Board title="Stage medians" icon="logs" span={4}>
      <BarList items={items} tone="info" empty="no stage has been timed yet" />
      <p className={BOARD_FOOT}>
        Median time per stage over the same window, with how many builds finished it. A stage a
        failed build completed counts.
      </p>
    </Board>
  )
}

function FailuresBoard({ h, now }: { h: History; now: number | null }) {
  return (
    <Board
      title="Latest failures"
      icon="warn"
      span={12}
      aside={<span className={BOARD_NOTE}>{String(h.failed)} in the window</span>}
    >
      {h.failures.length === 0 ? (
        <p className={VIZ_EMPTY}>No build failed in the last {String(h.days)} days.</p>
      ) : (
        <ul className={LIST}>
          {h.failures.map((f) => (
            <li key={f.id} className={ROW}>
              <Link
                to="/apps/$name/builds/$id"
                params={{ name: f.app, id: f.id }}
                className="inline-flex min-w-[10rem] items-baseline gap-[0.5rem] no-underline"
              >
                <span className="text-foreground">{f.app}</span>
                <code className="text-[0.74rem] text-(--dim)">{sha7(f.sha)}</code>
              </Link>
              <Chip tone="bad">{f.phase}</Chip>
              <span className={cn(ROW_MAIN, 'text-(--text-muted)')} title={f.error ?? undefined}>
                {f.error ?? 'no error recorded'}
              </span>
              <span className={ROW_SIDE}>{ago(now, f.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Board>
  )
}

/* ── toolchain ────────────────────────────────────────────────────────── */

function ToolchainBoard({ d }: { d: Builder }) {
  const facts = d.machinery.facts
  return (
    <Board title="Toolchain" icon="logs" span={6}>
      {d.toolchain.rows.length === 0 ? (
        <p className={VIZ_EMPTY}>The build tools’ pins are not published.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[0.3rem] p-0">
          {d.toolchain.rows.map((r) => (
            <ImageRow key={r.container} r={r} status={d.toolchain.status} />
          ))}
        </ul>
      )}
      <Facts
        list
        rows={[
          {
            k: 'BuildKit',
            v: <span className={MONO}>{facts?.buildkit.version ?? 'unknown'}</span>,
          },
        ]}
      />
      <h4 className={BOARD_SUB}>mise caches</h4>
      {facts === null ? (
        <p className={VIZ_EMPTY}>unknown until the builder snapshot is fresh</p>
      ) : facts.mise.length === 0 ? (
        <p className={VIZ_EMPTY}>no app has a mise cache yet</p>
      ) : (
        <ul className={LIST}>
          {facts.mise.map((m) => (
            <li key={m.app} className={ROW}>
              <span className={cn(ROW_MAIN, MONO)}>{m.app}</span>
              {!d.toolchain.apps.includes(m.app) && (
                <span className={ROW_SIDE}>no app of that name: inert</span>
              )}
              <span className={ROW_N}>{bytes(m.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={BOARD_FOOT}>
        Railpack, its frontend and mise move as one set, pinned in the engine; the checks run on
        their own node image. Release notes and the file each bump edits are on{' '}
        <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'updates' }}>
          System › Updates
        </Link>
        .
      </p>
    </Board>
  )
}

/* ── machinery ────────────────────────────────────────────────────────── */

type Machinery = Builder['machinery']
type BuilderUnit = NonNullable<Machinery['facts']>['units'][number]

const MISSING: Record<NonNullable<Machinery['missing']>, string> = {
  absent: 'The builder snapshot has not been published.',
  broken: 'The builder snapshot could not be read.',
  stale: 'The builder snapshot has stopped refreshing.',
}

const yes = (v: boolean | null, ok: string, bad: string) =>
  v === null ? <Chip>unknown</Chip> : <Chip tone={v ? 'ok' : 'bad'}>{v ? ok : bad}</Chip>

function unitTone(u: BuilderUnit): Tone {
  if (u.active === 'failed' || (u.result !== null && u.result !== 'success')) return 'bad'
  if (u.active === 'active') return 'ok'
  if (u.active === 'activating' || u.active === 'reloading') return 'info'
  return 'muted'
}

function MachineryBoard({ m, now }: { m: Machinery; now: number | null }) {
  const f = m.facts
  const quota = f?.storage.quotaBytes ?? null
  const used = f?.storage.usedBytes ?? null
  return (
    <Board
      title="Machinery"
      icon="logs"
      span={6}
      aside={
        <span className={BOARD_NOTE}>
          {m.generatedAt === null ? 'never published' : `read ${ago(now, m.generatedAt)}`}
        </span>
      }
    >
      {f === null || m.missing !== null ? (
        <p className={VIZ_EMPTY}>
          {MISSING[m.missing ?? 'absent']} Everything here is unknown until it is.
        </p>
      ) : (
        <>
          <Facts
            list
            rows={[
              {
                k: 'BuildKit daemon',
                v: yes(f.buildkit.reachable, 'answering', 'not answering'),
              },
              {
                k: 'Build cache',
                v: (
                  <span className="tabular-nums">
                    {bytes(f.buildkit.cacheBytes)}
                    <span className="text-(--dim)">
                      {' '}
                      · {bytes(f.buildkit.reclaimableBytes)} reclaimable
                    </span>
                  </span>
                ),
              },
              {
                k: 'Scratch dataset',
                v: (
                  <span className="inline-flex items-center gap-[0.5rem]">
                    <span className={MONO}>{f.storage.dataset || DASH}</span>
                    {yes(f.storage.mounted, 'mounted', 'NOT mounted')}
                  </span>
                ),
              },
              {
                k: 'Used',
                v: (
                  <span className="inline-flex items-center gap-[0.6rem] tabular-nums">
                    {quota !== null && used !== null && (
                      <span className="w-[6rem]">
                        <Progress
                          pct={(used / quota) * 100}
                          tone={used / quota > 0.85 ? 'warn' : 'accent'}
                        />
                      </span>
                    )}
                    <span>
                      {bytes(used)}
                      {quota !== null && <span className="text-(--dim)"> of {bytes(quota)}</span>}
                    </span>
                  </span>
                ),
              },
              { k: 'Egress fence', v: yes(f.fence.loaded, 'loaded', 'MISSING') },
              { k: 'Push credential', v: yes(f.credential.wellFormed, 'well-formed', 'refused') },
            ]}
          />
          <h4 className={BOARD_SUB}>Units</h4>
          <ul className={LIST}>
            {f.units.map((u) => (
              <li key={u.unit} className={ROW}>
                <span className={cn(ROW_MAIN, MONO)}>{u.unit}</span>
                <span className={ROW_SIDE}>
                  {u.lastExitAt === null ? '' : `last exit ${ago(now, u.lastExitAt)}`}
                </span>
                <Chip tone={unitTone(u)}>
                  {u.active}
                  {u.sub === '' ? '' : ` · ${u.sub}`}
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={BOARD_FOOT}>
        Read by the host every minute: the fence and the push credential are the exit codes of their
        own checks — neither the rules nor the password leave the host.
      </p>
    </Board>
  )
}

/* ── GitHub ───────────────────────────────────────────────────────────── */

type Github = Builder['github']

function GithubBoard({ g, now }: { g: Github; now: number | null }) {
  const site = useSite()
  const inst = g.installation
  return (
    <Board title="GitHub" icon="logs" span={12}>
      <Facts
        list
        rows={[
          {
            k: 'App installation',
            v:
              inst === null ? (
                <Chip>unknown</Chip>
              ) : (
                <span className="inline-flex items-center gap-[0.5rem]">
                  {inst.account !== null && <span>{inst.account.login}</span>}
                  <Chip tone={inst.state === 'ok' && !inst.stale ? 'ok' : 'warn'}>
                    {inst.stale ? `${inst.state}, stale` : inst.state}
                  </Chip>
                </span>
              ),
          },
          {
            k: 'API budget',
            v:
              g.rateLimit === null ? (
                DASH
              ) : (
                <span className="tabular-nums">
                  {g.rateLimit.remaining.toLocaleString('en-US')} of{' '}
                  {g.rateLimit.limit.toLocaleString('en-US')} left
                </span>
              ),
          },
          {
            k: 'Bad signatures, 24 h',
            v:
              g.rejected24h === null ? (
                DASH
              ) : (
                <span className={cn('tabular-nums', g.rejected24h > 0 && 'text-danger')}>
                  {String(g.rejected24h)}
                </span>
              ),
          },
        ]}
      />
      <h4 className={BOARD_SUB}>Latest deliveries</h4>
      {g.deliveries.length === 0 ? (
        <p className={VIZ_EMPTY}>none kept (a week’s worth is)</p>
      ) : (
        <ul className={LIST}>
          {g.deliveries.map((x) => (
            <li key={x.id} className={ROW}>
              <span className={ROW_MAIN}>
                {x.event}
                {x.action === null ? '' : ` · ${x.action}`}
              </span>
              <span className={cn(ROW_SIDE, MONO)}>{x.outcome}</span>
              <span className={ROW_SIDE}>{ago(now, x.receivedAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <h4 className={BOARD_SUB}>Reported back</h4>
      {g.reported.length === 0 ? (
        <p className={VIZ_EMPTY}>no build has posted a check run yet</p>
      ) : (
        <ul className={LIST}>
          {g.reported.map((b) => (
            <li key={b.id} className={ROW}>
              <Link
                to="/apps/$name/builds/$id"
                params={{ name: b.app, id: b.id }}
                className={cn(ROW_MAIN, 'no-underline')}
              >
                {b.app} <code className="text-[0.74rem] text-(--dim)">{sha7(b.sha)}</code>
              </Link>
              <BuildStateChip state={b.state} />
              {b.checkRunId !== null && (
                <a
                  className={ROW_SIDE}
                  href={`https://github.com/${appRepo(site, b.app)}/runs/${String(b.checkRunId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  check run ↗
                </a>
              )}
              {b.deploymentId !== null && (
                <a
                  className={ROW_SIDE}
                  href={`https://github.com/${appRepo(site, b.app)}/deployments`}
                  target="_blank"
                  rel="noreferrer"
                >
                  deployment ↗
                </a>
              )}
              <span className={ROW_SIDE}>{b.reported ? '' : 'not reported'}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={BOARD_FOOT}>
        Pushes reach the box through the App’s webhook; a delivery with a bad signature is refused
        before anything reads it. Each build reports back as a check run, and a live one as a
        Deployment.
      </p>
    </Board>
  )
}
