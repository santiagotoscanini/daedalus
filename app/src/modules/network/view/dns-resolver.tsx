import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import type { Tone } from '../../../components/viz'
import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Columns,
  Facts,
  Measures,
  Progress,
} from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, compact, DASH, ms, num, pct, since, until } from '../../../lib/format'
import type { NetworkData } from '../data'
import { FOLD_STACK } from './dns-records'
import { ACTION, FOOT, GROUP, MAIN, MONO, N, NOTE, ROW, ROWS, SIDE, SUB } from './shared'

// Network › DNS, the resolver side: pi-hole, as every device in the house
// meets it. One component per board, so the view reads as the list of them.

type Dns = Extract<NetworkData, { tab: 'dns' }>
type Resolver = Dns['resolver']

/** The four ways a query ends, in the order they are tried. */
const SOURCES = [
  { k: 'cached' as const, label: 'From cache', tone: 'ok' as Tone },
  { k: 'local' as const, label: 'Answered here', tone: 'accent' as Tone },
  { k: 'forwarded' as const, label: 'Forwarded', tone: 'info' as Tone },
  { k: 'blocked' as const, label: 'Blocked', tone: 'warn' as Tone },
]

export function ResolverView({
  d,
  lan,
  admin,
}: {
  d: Resolver
  lan: Dns['lan']
  admin: Dns['admin']
}) {
  return (
    <>
      <ServiceHead
        logo="/icon-pihole.svg"
        name="Pi-hole"
        version={d.version}
        versionNote="from the package the service runs"
        verdict={verdictOf(d.gap)}
        compare={[
          {
            k: 'Latest',
            v: d.gap.latest,
            note:
              d.gap.latest === null
                ? 'GitHub did not answer'
                : d.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          {
            k: 'Read from',
            v: null,
            // Worth stating: FTL does serve /api/info/version, and on this
            // installation it fails — it reads a file only the Docker image
            // writes. The NixOS package is the honest answer instead.
            note: 'the NixOS package, not FTL’s own version endpoint',
          },
        ]}
        lede={
          <>
            Every device in the house resolves through this, including this box. It answers for the{' '}
            {d.clients.total === null ? 'LAN' : `${num(d.clients.total)} clients`} it has seen, and
            forwards whatever it cannot answer itself. The addresses those clients hold are the{' '}
            <b>DHCP</b> tab.
          </>
        }
        actions={
          admin !== null && (
            <a className={ACTION} href={`${admin}/`} target="_blank" rel="noreferrer">
              Open the admin ↗
            </a>
          )
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.pi-hole.net/' },
          { label: 'GitHub', href: 'https://github.com/pi-hole/FTL' },
        ]}
      />

      <BoardGrid>
        <DeclaredNames lan={lan} />
        <AnswerSources d={d} />
        <Traffic d={d} />
        <ResolverItself d={d} />

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ unit: 'pihole-ftl.service' }}
          title="pihole-FTL logs"
          foot={
            <p className={FOOT}>
              Not the journal. FTL is the one service on this box that keeps its own log file, and
              the only journal lines about the unit come from systemd, so these are shipped out of{' '}
              <span className={MONO}>/var/log/pihole/FTL.log</span> by alloy. Startup, gravity runs,
              DHCP leases, NTP and upstream trouble. Individual queries are not here and
              deliberately never will be: that log is two gigabytes of every domain every device in
              the house asked for.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/** pi-hole's hosts file, joined to traefik's routers and the zone. */
function DeclaredNames({ lan }: { lan: Dns['lan'] }) {
  const unserved = lan.filter((n) => n.served === false)
  return (
    <Board
      title="The names we declare"
      icon="⌂"
      span={8}
      aside={
        <span className={NOTE}>
          {lan.length} entries · {lan.filter((n) => n.public).length} also public
        </span>
      }
    >
      {/* Forty short names. A wrapping flex rather than a grid of fixed
              columns: `jellyfin` and `homeassistant` differ by a factor of two,
              and a column wide enough for the longest leaves the shortest
              floating in whitespace. Wrapping puts as many on each line as fit
              and nothing anywhere else. */}
      <ul className="m-0 flex list-none flex-wrap gap-[0.3rem] p-0">
        {lan.map((n) => (
          <li
            key={n.fqdn}
            className={cn(
              'inline-flex min-w-0 items-center gap-[0.35rem] rounded-[7px] bg-(--panel-2) px-2 py-[0.22rem] text-[0.75rem]',
              // The one state worth interrupting the wall of names for.
              n.served === false && 'shadow-[inset_0_0_0_1px_var(--danger)]',
            )}
          >
            <span className={cn(MONO, 'text-foreground')}>{n.short}</span>
            {/* Printed only when the entry does not point at this box, so
                    it is a distinction rather than a column — it earns the eye
                    by being rare. */}
            {n.elsewhere && (
              <span className={cn(MONO, 'text-[0.68rem] text-(--dim) tabular-nums')}>{n.ip}</span>
            )}
            {n.public && <Chip tone="info">public</Chip>}
            {n.served === false && <Chip tone="bad">no route</Chip>}
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        The names this house answers for itself instead of asking anyone. Each one is an entry in
        pi-hole’s hosts file generated from the stack that owns it, so a name gets here by being
        declared and never by being typed into the admin. Nothing in this list can outlive the thing
        it points at. An address is printed only when the entry points somewhere other than this
        box. <b>public</b> marks the ones the zone publishes as well, which is the same set the
        other side of this tab lists, seen from outside.
        {unserved.length === 0
          ? ' Everything pointed at this box has a traefik router behind it.'
          : ' A name marked no route resolves, then lands on the default certificate and 404s.'}
      </p>
    </Board>
  )
}

/** The four ways a query ends, and the upstreams the forwarded ones went to. */
function AnswerSources({ d }: { d: Resolver }) {
  const { answered, queries } = d
  const sum = answered.cached + answered.local + answered.forwarded + answered.blocked
  const share = (n: number) => (sum === 0 ? null : (n / sum) * 100)
  return (
    <Board
      title="Where answers come from"
      icon="◈"
      span={4}
      aside={
        <span className={NOTE}>
          {queries.perSecond === null ? DASH : num(queries.perSecond, 1)}/s
        </span>
      }
    >
      {/* Four rows, one per way a query can end. A grid rather than the
              flat row default because the bars only compare if they start at
              the same x — ragged bars are four separate readings rather than
              one breakdown. */}
      <ul className={cn(ROWS, 'mt-[0.2rem]')}>
        {SOURCES.map((s) => (
          <li key={s.k} className={cn(ROW, 'grid grid-cols-[7.5rem_1fr_3.2rem] gap-[0.6rem]')}>
            <span className={MAIN}>{s.label}</span>
            <Progress pct={share(answered[s.k])} tone={s.tone} height={6} />
            <span className={N}>{pct(share(answered[s.k]), 1)}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        {num(sum)} queries in the window FTL keeps in memory. Cache and the hosts file never left
        the box, which is the whole job. The forwarded slice is the only part any upstream sees.
      </p>

      <h4 className={SUB}>Upstreams</h4>
      {/* Narrow board, so the address leads and everything else is allowed
              to be small: two resolvers at the same host name are told apart by
              their address, never by their label. The chip breaks the row's
              grid when it is there, which is the point — it only appears for a
              resolver that should not be in the list at all. */}
      <ul className={ROWS}>
        {d.upstreams.map((u) => (
          <li
            key={u.ip}
            className={cn(
              ROW,
              'grid gap-[0.4rem]',
              u.declared
                ? 'grid-cols-[minmax(5.5rem,1fr)_auto_3.6rem_3rem]'
                : 'grid-cols-[1fr_auto] gap-y-[0.15rem]',
            )}
          >
            <span className={cn(MAIN, MONO)}>{u.ip}</span>
            {!u.declared && <Chip tone="warn">not configured</Chip>}
            <span className={N}>{u.replyMs === null ? DASH : ms(u.replyMs)}</span>
            <span className={cn(MONO, SIDE, 'max-w-none text-right')}>{compact(u.count)}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        Mean round trip, as FTL measured it. That is what a page load waits for on a name nobody has
        asked for recently.
      </p>
    </Board>
  )
}

/** The last day of queries, an hour per column. */
function Traffic({ d }: { d: Resolver }) {
  const busiest = Math.max(...d.history.map((h) => h.total), 0)
  return (
    <Board
      title="Traffic"
      icon="⌁"
      span={8}
      aside={<span className={NOTE}>an hour per column</span>}
    >
      <Columns
        points={d.history.map((h) => ({
          label: h.label,
          value: h.total,
          display: `${num(h.total)} queries · ${num(h.forwarded)} forwarded`,
        }))}
        empty="pi-hole returned no history"
      />
      <p className={FOOT}>
        The last day, busiest hour {num(busiest)}. A house at rest still asks thousands of questions
        an hour, most of it background chatter from devices nobody is touching, which is why the
        cache share above is what it is.
      </p>
    </Board>
  )
}

/** The settings that can go wrong quietly, and the two folds under them. */
function ResolverItself({ d }: { d: Resolver }) {
  const paused = d.blocking.on === false
  return (
    <Board
      title="The resolver itself"
      icon="⚙"
      span={4}
      aside={paused ? <Chip tone="bad">blocking paused</Chip> : undefined}
    >
      <Measures
        items={[
          {
            k: 'Blocking',
            v:
              d.blocking.on === null
                ? DASH
                : d.blocking.on
                  ? 'on'
                  : `off, back in ${until(d.blocking.resumesIn)}`,
            tone: d.blocking.on === false ? 'bad' : 'ok',
          },
          {
            k: 'Cache',
            v: d.cache.evicted === 0 ? 'not full' : `${num(d.cache.evicted)} evicted`,
            tone: d.cache.evicted === 0 ? 'ok' : 'warn',
          },
          { k: 'Clients', v: num(d.clients.active), tone: 'muted' },
          { k: 'On the list', v: compact(d.lists.gravity), tone: 'muted' },
        ]}
      />
      <p className={FOOT}>
        The four that can go wrong quietly. Blocking is left off by a “disable for 5 minutes” nobody
        came back to; a cache with <i>evictions</i> is too small for the traffic, which expiries do
        not mean.
      </p>

      <details data-fold className={GROUP}>
        <summary>
          What is being asked
          <Chip tone="muted">{d.types.length}</Chip>
        </summary>
        <BarList
          items={d.types.slice(0, 6).map((t) => ({
            label: t.label,
            value: t.value,
            display: compact(t.value),
          }))}
          tone="info"
          empty="no query types reported"
        />
        <p className={FOOT}>
          A and AAAA are one question asked twice. Every modern client wants both addresses at once.
          PTR is reverse lookups, mostly this box naming its own LAN.
        </p>
      </details>

      <details data-fold className={cn(GROUP, FOLD_STACK)}>
        <summary>
          The query store
          <Chip tone="muted">{bytes(d.store.bytes)}</Chip>
        </summary>
        <Facts
          rows={[
            { k: 'Queries kept', v: compact(d.store.queries) },
            { k: 'Oldest', v: since(d.store.sinceSeconds) },
            { k: 'Allowed by hand', v: num(d.lists.allowed) },
            { k: 'Denied by hand', v: num(d.lists.denied) },
          ]}
        />
        <p className={FOOT}>
          Every query, with the client that asked and the domain it asked for. It is the most
          revealing file on the machine, which is why the admin sits behind the gate rather than
          behind a password.
        </p>
      </details>
    </Board>
  )
}
