import { LogBoard } from '../../../../components/logs'
import { useNow } from '../../../../components/poll'
import { Changelog } from '../../../../components/release-notes'
import { LinkRow, ServiceHead } from '../../../../components/service-head'
import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../../components/table'
import { TableSection } from '../../../../components/table-section'
import { Board, BoardGrid, Measures, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, localDay, num, until } from '../../../../lib/format'
import { useSite } from '../../../../lib/site-context'
import { CAPTION, EMPTY, FOOT, LIVE, MAIN, MONO, NOTE, ROW, ROWS, SIDE } from '../shared'
import type { Inbound } from './index'

/**
 * The address, and whether anything still points at it.
 *
 * This page exists because the failure is silent in both directions: a home
 * connection's address changes with no notice, and ddclient failing to notice
 * exits 0. Nothing alerts, nothing logs an error a human would see, and the
 * first symptom is somebody unable to join a Factorio game.
 */
export function DdnsView({ d }: { d: Inbound['ddns'] }) {
  const site = useSite()
  const f = ddnsFacts({ d }, site)
  const { known, match } = f

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name="Direct"
        version={d.resolved}
        versionNote={`what the world resolves ${d.host} to`}
        verdict={
          !known
            ? { label: 'unknown', tone: 'muted' }
            : match
              ? { label: 'pointing here', tone: 'ok' }
              : { label: 'stale', tone: 'bad' }
        }
        compare={[
          { k: 'Actually here', v: d.actual, note: 'the address the tunnel reports arriving from' },
          {
            k: 'Kept current by',
            v: `ddclient ${d.version ?? ''}`.trim(),
            note: 'platform/ddclient, every 5 minutes',
          },
        ]}
        lede={
          <>
            No proxy: the house’s own address, for anything that is not HTTP. A home connection’s
            address moves, and ddclient keeps <code>{d.host}</code> pointed at it.
          </>
        }
      />
      <LinkRow
        links={[
          { label: 'ddclient', href: 'https://github.com/ddclient/ddclient' },
          { label: 'The record', href: `https://dash.cloudflare.com/` },
        ]}
      />

      <BoardGrid>
        <IsTheNameRightBoard f={f} />

        <WhatNeedsItBoard f={f} />

        <TheAddressOverTimeBoard f={f} />

        <Changelog gap={d.gap} />

        <DdclientLogsBoard f={f} />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function ddnsFacts({ d }: { d: Inbound['ddns'] }, site: ReturnType<typeof useSite>) {
  const known = d.resolved !== null && d.actual !== null
  const match = known && d.resolved === d.actual
  return { d, known, match, site }
}

type DdnsFacts = NonNullable<ReturnType<typeof ddnsFacts>>

function IsTheNameRightBoard({ f }: { f: DdnsFacts }) {
  const { d, known, match, site } = f
  return (
    <Board
      title="Is the name right"
      icon="◎"
      span={8}
      aside={
        <span className={LIVE}>
          <Pulse on={match} tone={known && !match ? 'bad' : 'ok'} />
          {!known ? 'cannot tell' : match ? 'matches' : 'does not match'}
        </span>
      }
    >
      <Measures
        items={[
          { k: 'resolves to', v: d.resolved ?? DASH },
          {
            k: 'actually here',
            v: d.actual ?? DASH,
            tone: known && !match ? 'bad' : undefined,
          },
          { k: 'record ttl', v: d.ttl === null ? DASH : until(d.ttl) },
          {
            k: 'rechecked every',
            v: d.intervalSeconds === null ? DASH : until(d.intervalSeconds),
          },
        ]}
      />

      <p className={CAPTION}>
        {match ? (
          <>
            The name resolves to the address the tunnel reports traffic arriving from, so everything
            below can be reached.{' '}
          </>
        ) : known ? (
          <>
            <b>They disagree.</b> The name is pointing somewhere this box is not, so everything
            below is unreachable from outside until ddclient catches up. Its next run is within{' '}
            {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)}.{' '}
          </>
        ) : (
          <>One of the two could not be read, so this check is not currently making a claim. </>
        )}
      </p>
      <p className={FOOT}>
        Asked of <code>1.1.1.1</code> over HTTPS rather than this box’s resolver, deliberately:
        pi-hole short-circuits <code>*.{site.baseDomain}</code> to the LAN address, which is right
        and would make this check answer itself.
      </p>

      {/* The failure that has no other symptom. Counted from the log
          because the unit exits 0 either way. Warn rather than bad — it is
          something to look into, not something that is currently broken. */}
      {(d.lookupFailures.month ?? 0) > 0 && (
        <p className="m-0 rounded-xl border border-warning/25 bg-warning/8 px-4 py-3 text-[0.8rem] leading-[1.5] text-muted-foreground [&_b]:text-warning [&_b]:tabular-nums [&_b]:[font-weight:600]">
          ddclient could not work out this house’s address <b>{num(d.lookupFailures.day)}</b> times
          in the last day, <b>{num(d.lookupFailures.week)}</b> in the week and{' '}
          <b>{num(d.lookupFailures.month)}</b> in the month. Its lookup against{' '}
          <code>cloudflare.com/cdn-cgi/trace</code> got no answer. Each run that fails publishes
          nothing, so a real address change during one would not be noticed until the next success.{' '}
          {d.monitored
            ? 'It is in fleet.monitoredJobs, so a failure mails you.'
            : 'The unit still exits 0, so nothing alerts on it, including the OnFailure hook it does not have.'}
        </p>
      )}
    </Board>
  )
}

function WhatNeedsItBoard({ f }: { f: DdnsFacts }) {
  const { d } = f
  return (
    <Board
      title="What needs it"
      icon="⇥"
      span={4}
      aside={<span className={NOTE}>router-forwarded</span>}
    >
      {d.needs.length === 0 ? (
        <p className={EMPTY}>nothing declares a direct port</p>
      ) : (
        <ul className={ROWS}>
          {d.needs.map((n) => (
            <li key={n.name} className={ROW} title={n.note}>
              <span className="w-8 flex-none font-mono text-[0.72rem] text-muted-foreground">
                {n.proto}
              </span>
              <span className={MAIN}>{n.name}</span>
              <span className={cn(MONO, SIDE)}>{n.port}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        From <code>fleet.directIngress</code>, which each service declares beside its own firewall
        rule. This is the one registry on the box recording something nix does not own: the router’s
        port-forward table lives in the router. It is written next to the service so that removing
        the service takes the note with it. Everything else reaches this house through the tunnel
        and needs no address at all.
      </p>
    </Board>
  )
}

/** Address · held for · since. */
const ADDR_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1fr)_minmax(6rem,0.6fr)_7rem] @max-[30rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[30rem]/table:gap-x-3 @max-[30rem]/table:[&>.held]:hidden'

function TheAddressOverTimeBoard({ f }: { f: DdnsFacts }) {
  const { d } = f
  return (
    <TableSection title="The address, over time" aside={<Countdown at={d.nextRunAt} />}>
      <ul className={TABLE} aria-label="Address history">
        <li className={cn(ADDR_GRID, TABLE_HEAD)}>
          <span>Address</span>
          <span className="held">Held for</span>
          <span className="text-right">Since</span>
        </li>
        {d.history.length === 0 && (
          <li className={TABLE_EMPTY}>no change recorded in the log window</li>
        )}
        {/* The current address carries the ink; the ones it replaced are
            history and recede. */}
        {d.history.map((h) => (
          <li key={h.at} className={cn(ADDR_GRID, TABLE_ROW_DENSE)}>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  'truncate font-mono text-[0.76rem]',
                  h.heldDays === null ? 'text-foreground [font-weight:560]' : 'text-subdued',
                )}
              >
                {h.ip}
              </span>
              {/* On a phone "held for" is this second line. */}
              <span className="hidden text-[0.72rem] text-muted-foreground @max-[30rem]/table:block">
                {h.heldDays === null ? 'current' : `held ${String(h.heldDays)}d`}
              </span>
            </span>
            <span className={cn(CELL_QUIET, 'held')}>
              {h.heldDays === null ? (
                <span className="text-foreground">current</span>
              ) : (
                `${String(h.heldDays)}d`
              )}
            </span>
            <span className={cn(CELL_QUIET, 'text-right')}>{localDay(h.at)}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        {/* The pattern is the useful part: the changes and the failures
            are the same event seen twice, which is worth saying because
            otherwise the failures above look random. */}
        ddclient writes a line only when it <b>changes</b> the record, so this is the change history
        exactly, with nothing for the thousands of runs that found nothing to do. Every one of them
        lands around 04:00, which is the ISP renewing the lease; the failed lookups above cluster at
        the same hour, because the connection is down for the seconds it takes. Thirty days is the
        whole window. That is how long Loki keeps a line, not a choice made here.
      </p>
    </TableSection>
  )
}

function DdclientLogsBoard({ f }: { f: DdnsFacts }) {
  const { d } = f
  return (
    <LogBoard
      source={{ unit: 'ddclient.service' }}
      title="ddclient logs"
      foot={
        <p className={FOOT}>
          ddclient is host plumbing rather than a container, so these are journal lines. It runs
          every {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)} and says
          nothing on a successful run that changed nothing, which is most of them.
        </p>
      }
    />
  )
}

/**
 * A live countdown to the next run of a timer.
 *
 * The timer lives in systemd and this container cannot see it, so the moment
 * is derived on the server (last run + interval) and handed over as an
 * absolute instant. The ticking is `useNow`, which is where the after-mount
 * rule it depends on is written down.
 *
 * mm:ss rather than one unit — a five-minute countdown reading "5 min" for
 * two and a half minutes is not a countdown.
 */
function Countdown({ at }: { at: number | null }) {
  // Always ticking: unlike a build's elapsed time there is no idle state to
  // stop at — the timer is always on its way round.
  const now = useNow(true)

  if (at === null) return <span className={NOTE}>next run unknown</span>

  const left = now === null ? null : Math.max(0, Math.round((at - now) / 1000))
  return (
    <span className={NOTE}>
      next check{' '}
      {left === null ? (
        'soon'
      ) : // Overdue is a real state worth showing rather than clamping away: the
      // timer fires a little late, and a run that is genuinely stuck reads
      // as a countdown that sat at zero.
      left === 0 ? (
        'due now'
      ) : (
        <span className={MONO}>
          {String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}
        </span>
      )}
    </span>
  )
}
