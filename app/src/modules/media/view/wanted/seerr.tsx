// Wanted › Seerr: what people asked for, and how far each request has got.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Measures, RankRow } from '../../../../components/viz'
import { daysAgo, num } from '../../../../lib/format'
import { EMPTY, FOOT, LIST, NOTE } from '../shared'
import type { Wanted } from './shared'
import { WANTED_NEIGHBOURS } from './shared'

/* Status first, because it is the column that decides whether the row needs
   you. The title takes the slack; requester and age are fixed so the eye can
   run down them. Below 34rem the five stack. */
const REQS = `${LIST} gap-[0.2rem]`
const REQ =
  'grid grid-cols-[5.6rem_minmax(0,1fr)_3.6rem_6rem_5rem] items-center gap-[0.6rem] py-[0.22rem] text-[0.82rem] max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-[0.15rem]'
const REQ_SIDE = 'text-[0.75rem] text-muted-foreground'
const REQ_WHEN = `${REQ_SIDE} text-right max-[34rem]:text-left`

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
        <Board
          title="Recent requests"
          icon="✧"
          span={8}
          aside={<span className={NOTE}>{num(counts.total)} all time</span>}
        >
          {d.requests.length === 0 ? (
            <p className={EMPTY}>Nothing has been requested.</p>
          ) : (
            <ul className={REQS}>
              {d.requests.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className={REQ}>
                  <Chip tone={r.tone}>{r.status}</Chip>
                  <span className="truncate">{r.title}</span>
                  <span className={REQ_SIDE}>{r.kind === 'tv' ? 'series' : 'film'}</span>
                  <span className={REQ_SIDE}>{r.by}</span>
                  <span className={REQ_WHEN}>{daysAgo(r.ageDays)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Titles are looked up per request: a request record carries a TMDB id and nothing else,
            so Seerr resolves the name the same way its own interface does.
          </p>
        </Board>

        <Board title="Where they are" icon="clock" span={4}>
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

        <Board title="Who asks" icon="◍" span={4}>
          {d.people.length === 0 ? (
            <p className={EMPTY}>no requests yet</p>
          ) : (
            <ul className={`${LIST} gap-[0.1rem]`}>
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
          span={8}
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
