import { Link } from '@tanstack/react-router'
import type { BuilderData } from '../../lib/apps/builder'
import { sha7 } from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { bytes, DASH, ms, pct } from '../../lib/format'
import { Ago } from '../ago'
import { ImageRow } from '../image-row'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_N, ROW_SIDE, SUB } from '../tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Stat, StatStrip } from '../viz'
import { GithubBoard, MachineryBoard } from './builder-machinery'
import { NowBoard } from './builder-now'

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

export type Builder = BuilderData

export function BuilderView({ d }: { d: Builder }) {
  return (
    <BoardGrid>
      <NowBoard initial={d.now} />
      <HistoryBoard h={d.history} />
      <StagesBoard h={d.history} />
      <FailuresBoard h={d.history} />
      <ToolchainBoard d={d} />
      <MachineryBoard m={d.machinery} />
      <GithubBoard g={d.github} />
    </BoardGrid>
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
      aside={<span className={NOTE}>last {String(h.days)} days</span>}
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
        <p className={EMPTY}>No builds in this window.</p>
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
      <p className={FOOT}>
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
      <p className={FOOT}>
        Median time per stage over the same window, with how many builds finished it. A stage a
        failed build completed counts.
      </p>
    </Board>
  )
}

function FailuresBoard({ h }: { h: History }) {
  return (
    <Board
      title="Latest failures"
      icon="warn"
      span={12}
      aside={<span className={NOTE}>{String(h.failed)} in the window</span>}
    >
      {h.failures.length === 0 ? (
        <p className={EMPTY}>No build failed in the last {String(h.days)} days.</p>
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
                <code className="text-[0.74rem] text-muted-foreground">{sha7(f.sha)}</code>
              </Link>
              <Chip tone="bad">{f.phase}</Chip>
              <span className={cn(ROW_MAIN, 'text-subdued')} title={f.error ?? undefined}>
                {f.error ?? 'no error recorded'}
              </span>
              <span className={ROW_SIDE}>
                <Ago at={f.at} />
              </span>
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
        <p className={EMPTY}>The build tools’ pins are not published.</p>
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
      <h4 className={SUB}>mise caches</h4>
      {facts === null ? (
        <p className={EMPTY}>unknown until the builder snapshot is fresh</p>
      ) : facts.mise.length === 0 ? (
        <p className={EMPTY}>no app has a mise cache yet</p>
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
      <p className={FOOT}>
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
