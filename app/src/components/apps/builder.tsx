import { Link } from '@tanstack/react-router'
import type { BuilderData } from '../../lib/apps/builder'
import { cn } from '../../lib/cn'
import { bytes } from '../../lib/format'
import { ImageRow } from '../image-row'
import { EMPTY, FOOT, LIST, MONO, ROW, ROW_MAIN, ROW_N, ROW_SIDE, SUB } from '../tokens'
import { Board, BoardGrid, Facts } from '../viz'
import { FailuresSection, HistorySection } from './builder-history'
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
    <>
      <BoardGrid>
        <NowBoard initial={d.now} />
      </BoardGrid>
      <HistorySection h={d.history} />
      <FailuresSection h={d.history} />
      <div className="mt-10">
        <BoardGrid>
          <ToolchainBoard d={d} />
          <MachineryBoard m={d.machinery} />
          <GithubBoard g={d.github} />
        </BoardGrid>
      </div>
    </>
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
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
