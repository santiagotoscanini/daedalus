// Wanted › Seerr: what people asked for, and how far each request has got.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Measures, RankRow } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { daysAgo, num } from '../../../../lib/format'
import {
  CELL_NAME,
  CELL_QUIET,
  EMPTY,
  FOOT,
  LIST,
  NOTE,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from '../shared'
import type { Wanted } from './shared'
import { WANTED_NEIGHBOURS } from './shared'

/* Title takes the slack; status beside it is the column that decides whether
   the row needs you, so only the statuses that do (pending, declined, failed)
   are coloured. Kind and requester repeat down the table: quiet, and the first
   to go. */
const REQ_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,2fr)_6.5rem_4.5rem_minmax(0,1fr)_5.5rem]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_6.5rem_5.5rem]',
)
const WIDE = '@max-[40rem]/table:hidden'

/** Available is where every request ends up: quiet. In progress is plain ink; a request that needs somebody is a chip. */
function RequestStatus({
  status,
  tone,
}: {
  status: string
  tone: Wanted['seerr']['requests'][number]['tone']
}) {
  if (tone === 'ok' || tone === 'muted') return <span className={CELL_QUIET}>{status}</span>
  if (tone === 'info') return <span className="text-[0.78rem] text-foreground">{status}</span>
  return (
    <span>
      <Chip tone={tone}>{status}</Chip>
    </span>
  )
}

export function SeerrPage({ d }: { d: Wanted['seerr'] }) {
  const { counts } = d
  const maxRequests = Math.max(...d.people.map((p) => p.requests), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-seerr.svg"
        name="Seerr"
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/status')}
        lede={
          <>
            The front door. Somebody asks for a film or a series here, and if it is approved Seerr
            hands it straight to Radarr or Sonarr.
          </>
        }
        actions={<Open name="Seerr" host="seerr" />}
      />

      <BoardGrid>
        <TableSection
          title="Recent requests"
          note={`${num(counts.total)} all time`}
          foot={
            <p className={FOOT}>
              Titles are looked up per request: a request record carries a TMDB id and nothing else,
              so Seerr resolves the name the same way its own interface does.
            </p>
          }
        >
          <ul className={TABLE} aria-label="Recent requests">
            <li aria-hidden="true" className={cn(REQ_GRID, TABLE_HEAD)}>
              <span>Title</span>
              <span>Status</span>
              <span className={WIDE}>Kind</span>
              <span className={WIDE}>Asked by</span>
              <span className="text-right">Asked</span>
            </li>
            {d.requests.length === 0 ? (
              <li className={TABLE_EMPTY}>Nothing has been requested.</li>
            ) : (
              d.requests.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className={cn(REQ_GRID, TABLE_ROW)}>
                  <span className={cn(CELL_NAME, '[font-weight:500]')}>{r.title}</span>
                  <RequestStatus status={r.status} tone={r.tone} />
                  <span className={cn(CELL_QUIET, WIDE)}>
                    {r.kind === 'tv' ? 'series' : 'film'}
                  </span>
                  <span className={cn(CELL_QUIET, WIDE, 'truncate')}>{r.by}</span>
                  <span className={cn(CELL_QUIET, 'text-right')}>{daysAgo(r.ageDays)}</span>
                </li>
              ))
            )}
          </ul>
        </TableSection>

        <Board title="Where they are" icon="clock" span={6}>
          <Measures
            items={[
              {
                k: 'Pending',
                v: num(counts.pending),
                tone: (counts.pending ?? 0) > 0 ? 'warn' : undefined,
              },
              { k: 'Approved', v: num(counts.approved) },
              { k: 'Processing', v: num(counts.processing) },
              { k: 'Available', v: num(counts.available) },
              { k: 'Declined', v: num(counts.declined) },
            ]}
          />
          <p className={FOOT}>
            Pending is the only one that needs a person: everything else is either the machinery
            working or a decision already taken.
          </p>
        </Board>

        <Board title="Who asks" icon="◍" span={6}>
          {d.people.length === 0 ? (
            <p className={EMPTY}>no requests yet</p>
          ) : (
            <ul className={`${LIST} gap-0.5`}>
              {d.people.map((p) => (
                <RankRow
                  key={p.name}
                  name={p.name}
                  value={p.requests}
                  max={maxRequests}
                  meta={<span>{p.requests === 1 ? 'request' : 'requests'}</span>}
                />
              ))}
            </ul>
          )}
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.selfBehind !== null && d.selfBehind > 0 ? (
              <span className={NOTE}>{num(d.selfBehind)} commits behind, it says</span>
            ) : (
              <span className={NOTE}>github</span>
            )
          }
        />

        <LogBoard
          source={{ container: 'seerr' }}
          title="Seerr logs"
          neighbours={WANTED_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}
