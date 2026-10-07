// Wanted › Recyclarr: the quality profiles it syncs into the *arrs.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, ServiceHead, SOURCE_NOTE, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Measures } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, num } from '../../../../lib/format'
import {
  CELL_NAME,
  CELL_QUIET,
  FOOT,
  MONO,
  NOTE,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
  VERSION_SNAPSHOT,
} from '../shared'
import type { Wanted } from './shared'

/* Instance, then what the run changed and what it left alone. */
const SYNC_GRID = 'grid grid-cols-[minmax(0,1fr)_12rem_9rem] items-center gap-x-6 px-5'

export function RecyclarrPage({ d }: { d: Wanted['recyclarr'] }) {
  const recyclarr = d

  return (
    <>
      <ServiceHead
        logo="/icon-recyclarr.svg"
        name="Recyclarr"
        version={recyclarr.running.version}
        versionNote={SOURCE_NOTE[recyclarr.running.source]}
        verdict={verdictOf(recyclarr.gap)}
        compare={compareOf(
          recyclarr.gap,
          recyclarr.running.revision === null
            ? 'the image’s OCI label, since the pin is a bare major'
            : `the image’s OCI label, built from ${recyclarr.running.revision}`,
        )}
        lede={
          <>
            Syncs the TRaSH Guides into Sonarr and Radarr every night: custom formats, their scores,
            and the quality-definition sizes. When a profile changes back after you edited it by
            hand, this is what did it.
          </>
        }
        actions={
          recyclarr.lastRun === null ? (
            <Chip tone="muted">no run recorded</Chip>
          ) : (
            <Chip tone={recyclarr.lastRun.ok ? 'ok' : 'bad'}>
              {recyclarr.lastRun.ok ? 'last run ok' : 'last run failed'}
            </Chip>
          )
        }
      />

      <BoardGrid>
        <TableSection
          title="Last sync"
          note={recyclarr.lastRun?.day ?? DASH}
          foot={
            <p className={FOOT}>
              The last run&rsquo;s numbers, not a total: a nightly job that changed two formats
              every night for a week did not change fourteen. Read out of its log, because Recyclarr
              has no API, no metrics and no interface.
            </p>
          }
        >
          <ul className={TABLE} aria-label="Last sync">
            {recyclarr.synced.length > 0 && (
              <li aria-hidden="true" className={cn(SYNC_GRID, TABLE_HEAD)}>
                <span>Instance</span>
                <span className="text-right">Custom formats updated</span>
                <span className="text-right">Already current</span>
              </li>
            )}
            {recyclarr.synced.length === 0 ? (
              <li className={cn(TABLE_EMPTY, 'py-6')}>No sync recorded in the window.</li>
            ) : (
              recyclarr.synced.map((s) => (
                <li key={s.instance} className={cn(SYNC_GRID, TABLE_ROW)}>
                  <span className={CELL_NAME}>{s.instance}</span>
                  {/* A change is the reading; nothing changed is the norm. */}
                  <span
                    className={cn(CELL_QUIET, 'text-right', s.updated > 0 && 'text-foreground')}
                  >
                    {s.updated === 0 ? 'nothing changed' : num(s.updated)}
                  </span>
                  <span className={cn(CELL_QUIET, 'text-right')}>{num(s.skipped)}</span>
                </li>
              ))
            )}
          </ul>
        </TableSection>

        <Board title="Health" icon="warn" span={4}>
          <Measures
            items={[
              {
                k: `Errors, last ${String(d.days)} days`,
                v: num(recyclarr.errors),
                tone: (recyclarr.errors ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className={FOOT}>
            It runs once a day and exits. There is no process to probe between runs, so the only
            evidence it is working is the line its cron wrapper writes when it finishes.
          </p>
        </Board>

        <Changelog
          gap={recyclarr.gap}
          span={8}
          aside={
            recyclarr.running.revision === null ? (
              <span className={NOTE}>recyclarr/recyclarr</span>
            ) : (
              <span className={cn(NOTE, MONO)}>{recyclarr.running.revision}</span>
            )
          }
          foot={
            <p className={FOOT}>
              Recyclarr is pinned to a bare major (<span className={MONO}>:8</span>), which is a
              channel rather than a version. It prints no banner, exposes no API and logs nothing
              about itself. This page used to say its version could not be established. It can: the
              image records it, along with the commit it was built from.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'recyclarr' }}
          title="Recyclarr logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
