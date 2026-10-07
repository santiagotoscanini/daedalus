import { Link } from '@tanstack/react-router'
import { ACCESS_WINDOWS, type AccessWindow, WINDOW_SPEC } from '../../lib/access-window'
import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { useSite } from '../../lib/site-context'
import type { AppTabData } from '../../server/registry'
import { EMPTY, FOOT, SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Board, BoardGrid, Stat, StatStrip } from '../viz'
import {
  ACCESS_NOTE,
  AgentsBoard,
  ClientsBoard,
  CountriesBoard,
  GeoPanel,
  PathsBoard,
  RejectsBoard,
} from './access-boards'
import { LEDE } from './shared'

/** Two boards in one third-width column of the board grid, the last taking the slack. */
const STACK =
  'flex min-w-0 flex-col gap-4 [grid-column:span_4] max-[78rem]:[grid-column:span_12] [&>section:last-child]:flex-1'

export type AccessData = Extract<AppTabData, { kind: 'access' }>['access']

/**
 * Who is reaching this app from the internet.
 *
 * Only the Cloudflare tunnel can answer that. The edge forwards
 * Cf-Connecting-Ip and Cf-Ipcountry, traefik's access log keeps both (beside
 * User-Agent and X-Forwarded-For), and Loki has that log — so an app published through the tunnel has a
 * real client identity per request. A LAN request has none: rootlessport
 * rewrites the source address on the way in, and every device in the house
 * arrives as the same bridge IP.
 *
 * So this is not "no data yet" for an internal app, it is "there is no such
 * thing", and the empty state says which.
 */
export function Access({
  name,
  hostname,
  stage,
  access,
  range,
}: {
  name: string
  hostname: string
  stage: string
  access: AccessData
  range: AccessWindow
}) {
  const { grafanaUrl } = useSite()
  if (stage !== 'live') {
    return (
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12}>
          <p className={EMPTY}>
            {name} is {stage === 'off' ? 'not exposed' : 'on the LAN only'}, so there are no remote
            clients to break down.
          </p>
          <p className={FOOT}>
            Client IP and country come from the headers Cloudflare adds at the edge, which only
            exist on requests that arrive through the tunnel. LAN requests reach traefik through
            rootlessport, which replaces the source address: every phone, laptop and WireGuard peer
            in the house shows up as the same bridge IP. Set exposure to <strong>Public</strong>{' '}
            above to start collecting this.
          </p>
        </Board>
      </BoardGrid>
    )
  }

  const spec = WINDOW_SPEC[range]
  const okRate = access.total > 0 ? ((access.total - access.rejected) / access.total) * 100 : null
  const picker = (
    // Deliberately links, not buttons — the window is in the URL, so a chosen
    // range survives a refresh and can be sent to someone.
    <nav className={SEGMENT_TRACK}>
      {ACCESS_WINDOWS.map((w) => (
        <Link
          key={w}
          to="/apps/$name"
          params={{ name }}
          search={(prev) => ({ ...prev, tab: 'access' as const, range: w })}
          className={cn(
            SEGMENT_ITEM,
            'px-2.5 py-0.5 text-[0.78rem]',
            w === range && SEGMENT_ITEM_ON,
          )}
          // "true", not "page": the active window is the current selection,
          // not the current location — the page is the same either side.
          aria-current={w === range ? 'true' : undefined}
          replace
        >
          {WINDOW_SPEC[w].label}
        </Link>
      ))}
    </nav>
  )

  if (!access.available) {
    return (
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12} aside={picker}>
          <p className={EMPTY}>Loki did not answer. The access log is the only source here.</p>
        </Board>
      </BoardGrid>
    )
  }

  return (
    // The strip, the board grid and the range picker are plain siblings here,
    // so the column supplies the gap between them — and the strip's own bottom
    // margin, for normal flow, is meant to be taken back off so the two do not
    // add up. StatStrip no longer carries a `.strip` class (its box is
    // viz.tsx's STAT_STRIP), so `[&>.strip]:mb-0` currently matches nothing.
    <div className="flex flex-col gap-3.5 [&>.strip]:mb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2.5">
        {/* No cap on the measure: the sentence names a hostname and a window
            and belongs on one line whenever the page is wide enough for it. */}
        <p className={cn(LEDE, 'm-0 max-w-none flex-[1_1_20rem]')}>
          Remote requests to <code>{hostname}</code> over {spec.prose}, from traefik&rsquo;s access
          log.
        </p>
        {picker}
      </div>

      {access.truncated && (
        <Alert className="mb-5 border-info/35 bg-info/7 text-subdued">
          <AlertDescription>
            More requests than one query can return. The totals below are exact; the breakdowns
            describe the most recent {num(access.sampled)}.
          </AlertDescription>
        </Alert>
      )}

      <StatStrip>
        <Stat
          label="Remote requests"
          value={access.total.toLocaleString('en-US')}
          spark={access.series}
          sub={spec.prose}
        />
        <Stat
          label="Unique clients"
          value={access.clients.toLocaleString('en-US')}
          unit="IPs"
          sub="distinct addresses"
        />
        <Stat
          label="Countries"
          value={access.countries.toLocaleString('en-US')}
          sub="by edge header"
        />
        <Stat
          label="Rejected"
          value={access.rejected.toLocaleString('en-US')}
          tone={okRate !== null && okRate < 50 ? 'warn' : undefined}
          sub={okRate === null ? 'nothing to rate' : `${okRate.toFixed(0)}% ok`}
        />
      </StatStrip>

      {access.total === 0 ? (
        <BoardGrid>
          <Board title="Where from" icon="⊕" span={12}>
            <p className={EMPTY}>
              Nothing arrived through the tunnel in {spec.prose}. The route exists; nothing outside
              is visiting it.
            </p>
            <p className={FOOT}>{ACCESS_NOTE}</p>
          </Board>
        </BoardGrid>
      ) : (
        <BoardGrid>
          <GeoPanel hostname={hostname} range={range} />

          {/* The two lists stacked beside the map: Countries is a couple of
              rows, so alone it was a tall board with nothing in it. */}
          <div className={STACK}>
            <CountriesBoard access={access} />
            <ClientsBoard access={access} />
          </div>

          {/* Wide: a path is the longest label on the page. */}
          <PathsBoard access={access} />

          <AgentsBoard access={access} />

          <RejectsBoard access={access} grafanaUrl={grafanaUrl} range={range} />
        </BoardGrid>
      )}
    </div>
  )
}
