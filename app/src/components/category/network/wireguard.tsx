import { useEffect, useState } from 'react'
import { cn } from '../../../lib/cn'
import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { bytes, DASH, ms, num, since, until } from '../../../lib/format'
import { BASE_DOMAIN, stripBaseDomain } from '../../../lib/site'
import { Segmented } from '../../controls'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Columns, Measures, Pulse } from '../../viz'
import {
  ACTION,
  AXIS,
  EMPTY,
  FOOT,
  LIVE,
  MAIN,
  MONO,
  NOTE,
  ROW,
  ROWS,
  SIDE,
  SWITCH_BAR,
  tone,
} from './shared'

// ── Coming in ──────────────────────────────────────────────────────────────

type Inbound = Extract<NetworkData, { tab: 'wireguard' }>

/**
 * Three ways in, and they have almost nothing in common.
 *
 * The tunnel is an outbound connection cloudflared holds open, so the edge
 * reaches this box without the router ever accepting one. WireGuard is the
 * exception: one forwarded UDP port, acceptable only because the protocol
 * ignores unauthenticated packets. And the third is no proxy at all — the
 * address itself, for the things that speak neither HTTP nor WireGuard.
 *
 * Three different pieces of software, three different failure modes, so each
 * gets its own header and its own boards rather than a shared row that would
 * fit none of them. What IS shared is the strip above the switch: which of the
 * three is working, all at once, so a broken one is visible without visiting
 * it. That is the whole reason they live on one tab instead of three.
 */
export function InboundView({ data }: { data: Inbound }) {
  // Direct first and selected by default: it is the plainest of the three —
  // a name resolving to this house's address, no proxy and no tunnel — and
  // the other two are each a layer added on top of it. Reading them in that
  // order is reading them in the order they were built.
  const [route, setRoute] = useState<'direct' | 'tunnel' | 'wireguard'>('direct')
  const { wireguard, tunnel, ddns } = data

  const wgOk = (wireguard.counts.configured ?? 0) > 0
  const tunnelOk = tunnel.status === 'healthy'
  // The address is right when the name resolves to where the tunnel says
  // traffic is actually arriving from. Unknown on either side is not a fault.
  const dnsOk =
    ddns.resolved === null || ddns.actual === null ? null : ddns.resolved === ddns.actual

  return (
    <>
      {/* Each route's health rides the button that selects it. There was a
          second row of the same three names carrying the same three dots, and
          a name printed twice is a name the reader has to reconcile — this
          says it once, in the only place it can be read without selecting the
          route it belongs to. */}
      <div className={SWITCH_BAR}>
        <Segmented
          value={route}
          onChange={setRoute}
          label="Route"
          options={[
            { value: 'direct', label: 'Direct', dot: tone(dnsOk) },
            { value: 'tunnel', label: 'Cloudflare tunnel', dot: tone(tunnelOk) },
            { value: 'wireguard', label: 'WireGuard', dot: tone(wgOk) },
          ]}
        />
      </div>

      {route === 'tunnel' ? (
        <CfTunnelView t={tunnel} />
      ) : route === 'direct' ? (
        <DdnsView d={ddns} />
      ) : (
        <WireguardView data={wireguard} />
      )}
    </>
  )
}

/**
 * The way back into the house.
 *
 * One question, really: can I get in, and is anything configured that should
 * not be. So the peer list is the page — every peer, whether or not it has
 * ever connected, with the handshake that is the only liveness WireGuard has.
 * A peer that exists and has never handshaken is a credential somebody was
 * issued and never used, which is worth seeing on a list of two.
 */
function WireguardView({ data }: { data: Inbound['wireguard'] }) {
  const { gap, counts, peers, daily } = data
  const live = counts.connected !== null && counts.connected > 0
  const max = Math.max(...peers.map((p) => p.rx + p.tx), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-wireguard.svg"
        name="WireGuard"
        version={data.version}
        versionNote="wg-easy, pinned in the flake"
        verdict={verdictOf(gap)}
        compare={[
          {
            k: 'Latest',
            v: gap.latest,
            note:
              gap.latest === null
                ? 'GitHub did not answer'
                : gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'an exact tag in stacks/wg-easy' },
        ]}
        lede={
          <>
            The one service the router forwards a port for, and the only way back into this house
            from outside it. UDP 51820. A WireGuard socket does not answer an unauthenticated packet
            at all, which is why a forwarded port is acceptable here.
          </>
        }
        actions={
          data.url === null ? undefined : (
            <a className={ACTION} href={data.url} target="_blank" rel="noreferrer">
              Open wg-easy ↗
            </a>
          )
        }
      />
      <LinkRow
        links={[
          { label: 'WireGuard', href: 'https://www.wireguard.com/' },
          { label: 'wg-easy', href: 'https://github.com/wg-easy/wg-easy' },
        ]}
      />

      <BoardGrid>
        <Board
          title="Peers"
          icon="key"
          span={8}
          aside={
            <span className={LIVE}>
              <Pulse on={live} tone="ok" />
              {live ? `${num(counts.connected)} connected` : 'nobody dialled in'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'configured', v: num(counts.configured) },
              { k: 'enabled', v: num(counts.enabled) },
              { k: 'connected now', v: num(counts.connected) },
            ]}
          />

          {peers.length === 0 ? (
            <p className={EMPTY}>no peers configured</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-[0.1rem] p-0">
              {peers.map((p) => (
                // Fixed name and count tracks, not `auto`. Each row is its own
                // grid container, so a content-sized column is measured per
                // row — the bars would start at a different x on every line and
                // stop at a different one, which is the entire comparison this
                // list exists to make.
                <li
                  className="grid min-w-0 grid-cols-[9.5rem_minmax(2rem,1fr)_2.6rem] items-center gap-x-[0.55rem] gap-y-[0.1rem] rounded-[7px] px-[0.45rem] py-[0.3rem] hover:bg-(--panel-2)"
                  key={p.name}
                >
                  <span className="flex min-w-0 items-baseline gap-[0.35rem] text-[0.79rem]">
                    <span className="min-w-0 truncate" title={p.name}>
                      {p.name}
                    </span>
                    {/* Deliberately switched off is not a warning at all — it
                        explains the silence rather than reporting it. */}
                    {!p.enabled && (
                      <em className="flex-none rounded-full border border-border px-[0.35rem] py-[0.02rem] text-[0.6rem] text-(--dim) not-italic">
                        disabled
                      </em>
                    )}
                    {p.handshakeAgo === null && (
                      <em className="flex-none rounded-full border border-[color-mix(in_srgb,var(--warning)_40%,transparent)] px-[0.35rem] py-[0.02rem] text-[0.6rem] text-warning not-italic">
                        never used
                      </em>
                    )}
                  </span>
                  <span className="block h-[5px] overflow-hidden rounded-[3px] bg-(--raise)">
                    <span
                      className="block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-[3px] bg-info opacity-85 motion-reduce:animate-none"
                      style={{ width: `${String(Math.max(1.5, ((p.rx + p.tx) / max) * 100))}%` }}
                    />
                  </span>
                  <span className="text-right text-[0.79rem] whitespace-nowrap tabular-nums">
                    {bytes(p.rx + p.tx)}
                  </span>
                  {/* Interpuncts are generated between the items rather than
                      typed, so a peer with no address does not trail a
                      separator into empty space. */}
                  <span className="col-span-full flex min-w-0 flex-wrap gap-x-[0.4rem] gap-y-0 text-[0.69rem] text-(--dim) tabular-nums [&>span+span]:before:mr-[0.4rem] [&>span+span]:before:text-border [&>span+span]:before:content-['·']">
                    {p.ipv4 !== null && <span className={cn(MONO, 'truncate')}>{p.ipv4}</span>}
                    {/* Named rather than arrowed. An arrow on a VPN row is
                        ambiguous by construction — the same byte is the
                        peer's upload and the server's download — so these say
                        which end they are counted at. */}
                    <span>{bytes(p.rx)} from it</span>
                    <span>{bytes(p.tx)} to it</span>
                    <span>{p.ago}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className={FOOT}>
            {/* The distinction that trips people up: WireGuard is
                connectionless, so there is no session to be in or out of. */}
            Ranked by total traffic. WireGuard has no connections to count. A peer is
            &ldquo;connected&rdquo; only in the sense that it exchanged a handshake recently, so a
            phone that is asleep reads as absent and is not. The byte counters are cumulative and
            reset when wg-easy restarts, which is why they are a ranking here rather than a rate.
          </p>
        </Board>

        <Board
          title="Anyone home"
          icon="clock"
          span={4}
          aside={<span className={NOTE}>peak per day, 14d</span>}
        >
          <Columns
            points={daily.map((d) => ({
              label: d.date.slice(5),
              value: d.peers,
              display: `${num(d.peers)} peer${d.peers === 1 ? '' : 's'} at peak`,
            }))}
            tone="ok"
            height={112}
            empty="no history yet"
          />
          {daily.length > 0 && (
            <p className={AXIS}>
              <span>{daily[0]?.date.slice(5)}</span>
              <span>peers at peak</span>
              <span>{daily[daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}
          <p className={FOOT}>
            Peak rather than average, because the question is whether the tunnel got used at all and
            a twenty-minute session averages to nearly nothing over a day. An empty column is a day
            nobody was away from the house, not a fault.
          </p>
        </Board>

        <Changelog gap={gap} />

        {/* No neighbours: wg-easy runs the tunnel, the web UI and the exporter
            in one container, and nothing else on the box is part of it. */}
        <LogBoard source={{ container: 'wg-easy' }} title="wg-easy logs" />
      </BoardGrid>
    </>
  )
}

/**
 * The Cloudflare tunnel, from both ends.
 *
 * Cloudflare knows what the edge sees; cloudflared knows what this box sent.
 * The panel that matters is the second one: `published` is every hostname the
 * tunnel will answer for, which is the literal answer to "what of this house
 * is reachable from the internet" — a question no other page here asks, and
 * one whose wrong answer is a service exposed by accident.
 */
function CfTunnelView({ t }: { t: Inbound['tunnel'] }) {
  const healthy = t.status === 'healthy'

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name="Cloudflare tunnel"
        version={t.version}
        versionNote="cloudflared, as the edge reports it"
        verdict={verdictOf(t.gap)}
        compare={[
          {
            k: 'Latest',
            v: t.gap.latest,
            note:
              t.gap.latest === null
                ? 'GitHub did not answer'
                : t.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(t.gap.behind.length)} release${t.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'a digest in stacks/cloudflared' },
        ]}
        lede={
          <>
            An <b>outbound</b> connection cloudflared holds open to Cloudflare, which the edge then
            reaches this box through. So the router never accepts an inbound connection for it: no
            forwarded port, nothing to scan. Everything it carries is HTTP, terminated at traefik’s{' '}
            <code>cfweb</code> entrypoint on plain HTTP because the edge already did TLS.
          </>
        }
        actions={
          <a
            className={ACTION}
            href="https://one.dash.cloudflare.com/"
            target="_blank"
            rel="noreferrer"
          >
            Cloudflare dashboard ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'cloudflared', href: 'https://github.com/cloudflare/cloudflared' },
          {
            label: 'Docs',
            href: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/',
          },
        ]}
      />

      <BoardGrid>
        <Board
          title="Holding the tunnel"
          icon="⇥"
          span={8}
          aside={
            <span className={LIVE}>
              <Pulse on={healthy} tone={healthy ? 'ok' : 'bad'} />
              {t.status ?? 'unknown'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'connections', v: num(t.connections) },
              { k: 'edge round trip', v: ms(t.rttMs) },
              { k: 'held for', v: since(t.heldForSeconds).replace(' ago', '') },
              {
                k: 'errors',
                v: num(t.errors),
                tone: t.errors !== null && t.errors > 0 ? 'bad' : undefined,
              },
            ]}
          />

          <Columns
            points={t.daily.map((d) => ({
              label: d.date.slice(5),
              value: d.requests,
              display: `${num(d.requests)} request${d.requests === 1 ? '' : 's'}`,
            }))}
            height={112}
            empty="no history yet"
          />
          {t.daily.length > 0 && (
            <p className={AXIS}>
              <span>{t.daily[0]?.date.slice(5)}</span>
              <span>requests from outside, per day</span>
              <span>{t.daily[t.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <p className={FOOT}>
            Four connections into{' '}
            {t.edges.length === 0
              ? 'the edge.'
              : `${t.edges.map((e) => `${e.colo}×${String(e.count)}`).join(' · ')}.`}{' '}
            Two datacentres, so losing one is a reconnect rather than an outage. The counts are
            small on purpose: almost everything here is reached over the LAN, and the tunnel only
            carries what is genuinely away from home. <b>Held for</b> is the oldest connection, not
            the newest, since the newest may have rotated seconds ago and says nothing.
          </p>
        </Board>

        <Board
          title="Published to the world"
          icon="◍"
          span={4}
          aside={<span className={NOTE}>{t.published.length} hostnames</span>}
        >
          {t.published.length === 0 ? (
            <p className={EMPTY}>could not read the tunnel’s ingress rules</p>
          ) : (
            <ul className={ROWS}>
              {t.published.map((p) => (
                <li key={p.hostname} className={ROW}>
                  <span className={MAIN}>{stripBaseDomain(p.hostname)}</span>
                  <span className={cn(MONO, SIDE)}>{p.service.replace(/^https?:\/\//, '')}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Read back from the tunnel’s own ingress rules, which is the only list that decides
            anything. A hostname here is reachable from the internet; one that is not here is not,
            whatever DNS says. Every entry is generated by a <code>webApps.exposeRemotely</code>, so
            this is that decision as Cloudflare received it. They all point at the same place:
            traefik’s plain-HTTP <code>cfweb</code> entrypoint.
          </p>
        </Board>

        <Changelog gap={t.gap} />

        <LogBoard
          source={{ container: 'cloudflared' }}
          title="cloudflared logs"
          neighbours={[
            {
              source: { unit: 'cloudflared-route-sync.service' },
              label: 'Route sync',
              role: 'what puts the public names in the zone',
              note: 'A oneshot that upserts one CNAME per fleet.cloudflareRoutes entry into the Cloudflare zone. The tunnel coming up proves nothing about whether a hostname resolves to it. A route declared in nix whose CNAME was never written is this unit having failed, and that is invisible from the tunnel’s own log.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

/**
 * The address, and whether anything still points at it.
 *
 * This page exists because the failure is silent in both directions: a home
 * connection's address changes with no notice, and ddclient failing to notice
 * exits 0. Nothing alerts, nothing logs an error a human would see, and the
 * first symptom is somebody unable to join a Factorio game.
 */
function DdnsView({ d }: { d: Inbound['ddns'] }) {
  const known = d.resolved !== null && d.actual !== null
  const match = known && d.resolved === d.actual

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
            No proxy at all. The house’s own address. The tunnel carries HTTP and nothing else, so
            anything speaking another protocol has to be dialled directly, and a home connection’s
            address moves. ddclient is what keeps <code>{d.host}</code> pointed at it.
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

          <p className={FOOT}>
            {match ? (
              <>
                The name resolves to the address the tunnel reports traffic arriving from, so
                everything below can be reached.{' '}
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
            Asked of <code>1.1.1.1</code> over HTTPS rather than this box’s resolver, deliberately:
            pi-hole short-circuits <code>*.{BASE_DOMAIN}</code> to the LAN address, which is right
            and would make this check answer itself.
          </p>

          {/* The failure that has no other symptom. Counted from the log
              because the unit exits 0 either way. Warn rather than bad — it is
              something to look into, not something that is currently broken. */}
          {(d.lookupFailures.month ?? 0) > 0 && (
            <p className="mt-[0.5rem] mb-0 rounded-[7px] border border-[color-mix(in_srgb,var(--warning)_32%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] px-[0.55rem] py-[0.4rem] text-[0.72rem] leading-[1.45] text-(--text-muted) [&_b]:font-semibold [&_b]:text-warning [&_b]:tabular-nums">
              ddclient could not work out this house’s address <b>{num(d.lookupFailures.day)}</b>{' '}
              times in the last day, <b>{num(d.lookupFailures.week)}</b> in the week and{' '}
              <b>{num(d.lookupFailures.month)}</b> in the month. Its lookup against{' '}
              <code>cloudflare.com/cdn-cgi/trace</code> got no answer. Each run that fails publishes
              nothing, so a real address change during one would not be noticed until the next
              success.{' '}
              {d.monitored
                ? 'It is in fleet.monitoredJobs, so a failure mails you.'
                : 'The unit still exits 0, so nothing alerts on it, including the OnFailure hook it does not have.'}
            </p>
          )}
        </Board>

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
                  <Chip tone="info">{n.proto}</Chip>
                  <span className={MAIN}>{n.name}</span>
                  <span className={cn(MONO, SIDE)}>{n.port}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            From <code>fleet.directIngress</code>, which each service declares beside its own
            firewall rule. This is the one registry on the box recording something nix does not own:
            the router’s port-forward table lives in the router. It is written next to the service
            so that removing the service takes the note with it. Everything else reaches this house
            through the tunnel and needs no address at all.
          </p>
        </Board>

        <Board
          title="The address, over time"
          icon="clock"
          span={6}
          aside={<Countdown at={d.nextRunAt} />}
        >
          {d.history.length === 0 ? (
            <p className={EMPTY}>no change recorded in the log window</p>
          ) : (
            <ul className={ROWS}>
              {d.history.map((h) => (
                <li key={h.at} className={ROW}>
                  <span className={cn(MAIN, MONO)}>{h.ip}</span>
                  <span className={SIDE}>
                    {h.heldDays === null ? 'current' : `held ${String(h.heldDays)}d`} ·{' '}
                    {new Date(h.at).toLocaleDateString('en-CA')}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            {/* The pattern is the useful part: the changes and the failures
                are the same event seen twice, which is worth saying because
                otherwise the failures above look random. */}
            ddclient writes a line only when it <b>changes</b> the record, so this is the change
            history exactly, with nothing for the thousands of runs that found nothing to do. Every
            one of them lands around 04:00, which is the ISP renewing the lease; the failed lookups
            above cluster at the same hour, because the connection is down for the seconds it takes.
            Thirty days is the whole window. That is how long Loki keeps a line, not a choice made
            here.
          </p>
        </Board>

        <Changelog gap={d.gap} span={6} />

        <LogBoard
          source={{ unit: 'ddclient.service' }}
          title="ddclient logs"
          foot={
            <p className={FOOT}>
              ddclient is host plumbing rather than a container, so these are journal lines. It runs
              every {d.intervalSeconds === null ? 'five minutes' : until(d.intervalSeconds)} and
              says nothing on a successful run that changed nothing, which is most of them.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * A live countdown to the next run of a timer.
 *
 * The timer lives in systemd and this container cannot see it, so the moment
 * is derived on the server (last run + interval) and handed over as an
 * absolute instant. The ticking is client-side and starts only after mount:
 * `now` is null through the server render AND the first client render, so both
 * produce the same markup and hydration has nothing to disagree about. A
 * countdown computed from `Date.now()` during render is the classic way to
 * break that.
 *
 * mm:ss rather than one unit — a five-minute countdown reading "5 min" for
 * two and a half minutes is not a countdown.
 */
function Countdown({ at }: { at: number | null }) {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [])

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
