import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, duration, num, pct } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../viz'

/* ── Database ─────────────────────────────────────────────────────────── */

type Database = Extract<SystemData, { tab: 'database' }>

export function DatabaseView({ d }: { d: Database }) {
  const worstCache = [...d.databases]
    .filter((x) => x.cacheHitPct !== null)
    .sort((a, b) => (a.cacheHitPct ?? 0) - (b.cacheHitPct ?? 0))[0]

  return (
    <>
      <ServiceHead
        logo="/icon-postgres.svg"
        name="PostgreSQL"
        version={d.gap.installed ?? d.version}
        versionNote="reported by the cluster itself"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from pg_static, via the exporter')}
        lede={
          <>
            One cluster, every app a tenant with its own role and database. That consolidation
            replaced a postgres container per stack, and it makes this the single process most of
            this box depends on. Its minor releases are worth reading: they are almost entirely
            security and data-corruption fixes, and applying one is a restart every tenant feels.
          </>
        }
      />

      <BoardGrid>
        <Board
          title="The cluster"
          icon="◱"
          span={8}
          aside={
            <span className="board-note">
              {d.version ?? ''} · {num(d.databases.length)} databases
            </span>
          }
        >
          <Measures
            items={[
              { k: 'on disk', v: bytes(d.totals.sizeBytes) },
              {
                k: 'connections',
                v: `${num(d.totals.connections)} / ${num(d.totals.maxConnections)}`,
              },
              { k: 'locks held', v: num(d.totals.locks) },
              { k: 'longest transaction', v: duration(d.totals.longestTxSeconds) },
            ]}
          />
          <p className="board-foot">
            One cluster, every app a tenant with its own role and database, replacing a postgres
            container per stack. That is why a mid-life restart here is felt everywhere: Pocket ID
            fails its health check the moment it cannot resolve <span className="mono">pg</span>,
            and every SSO app follows it down. <b>Longest transaction</b> is the stuck-query signal.
            A number that climbs and does not reset is something holding a lock nobody is waiting on
            any more.
          </p>
        </Board>

        <Board title="Serving from" icon="◍" span={4}>
          <Facts
            rows={[
              {
                k: 'Status',
                v:
                  d.up === null ? (
                    DASH
                  ) : d.up ? (
                    <Chip tone="ok">up</Chip>
                  ) : (
                    <Chip tone="bad">not answering</Chip>
                  ),
              },
              { k: 'Temp files written', v: bytes(d.totals.tempBytes) },
              {
                k: 'Lowest cache hit rate',
                v: worstCache === undefined ? DASH : `${pct(worstCache.cacheHitPct, 2)}`,
              },
              { k: 'in', v: worstCache?.name ?? DASH },
            ]}
          />
          <p className="board-foot">
            A cache hit rate below about 99% means the cluster is going to disk for pages it should
            have had in memory. Temp bytes are queries that outgrew{' '}
            <span className="mono">work_mem</span> and spilled. Both are tuning signals rather than
            faults, and neither shows in the size column.
          </p>
        </Board>

        <Board title="Tenants" icon="rows" span={12}>
          <ul className="itemlist">
            {d.databases.map((db) => (
              <li key={db.name}>
                <span className="item-main mono">{db.name}</span>
                <span className="item-side">{num(db.connections)} conn</span>
                <span className="item-side">{pct(db.cacheHitPct, 2)} cached</span>
                <span className="item-side">
                  {(db.deadlocks ?? 0) > 0 ? (
                    <span className="text-warn">{num(db.deadlocks)} deadlocks</span>
                  ) : (
                    `${num(db.rollbacks)} rollbacks`
                  )}
                </span>
                <span className="item-n">{bytes(db.sizeBytes)}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            Rollbacks are shown rather than commits because the ratio is what carries information. A
            tenant rolling back a large share of its transactions is either retrying or erroring,
            and neither shows up in its own logs as clearly as it does here. A database that appears
            with no app is one whose stack was removed without dropping it.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          aside={<span className="board-note">postgresql.org</span>}
          foot={
            <p className="board-foot">
              Not from GitHub, unlike every other changelog here: the{' '}
              <span className="mono">postgres/postgres</span> mirror carries tags and publishes no
              releases at all, so the usual reader reports the one service on this box whose minors
              are pure security fixes as having nothing to show. These come from{' '}
              <span className="mono">postgresql.org/docs/release</span> instead. Only the running
              MAJOR is counted. A major upgrade is a pg_upgrade with every tenant offline, which is
              not what &ldquo;behind&rdquo; means anywhere else on this dashboard. Read the{' '}
              <b>Migration</b> section first: it is the one paragraph that says whether the restart
              is all it takes.
            </p>
          }
        />

        <LogBoard
          source={{ stack: 'app-db' }}
          title="Cluster logs"
          neighbours={[
            {
              source: { unit: 'app-db-bootstrap.service' },
              label: 'Bootstrap',
              role: 'what creates a tenant’s role and database',
              note: 'Materialises one role, one database and one env file per fleet.appDatabases entry, generating the password on the box rather than in the store. An app that suddenly cannot connect after being declared is usually this not having run. Every tenant is ordered after it, and after podman-pg itself, so a mass restart re-queues them.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
