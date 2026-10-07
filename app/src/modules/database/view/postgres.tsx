import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, duration, num, pct } from '../../../lib/format'
import type { DatabaseData } from '../data'

/* ── Postgres ─────────────────────────────────────────────────────────── */

type Postgres = Extract<DatabaseData, { tab: 'postgres' }>

export function PostgresView({ d }: { d: Postgres }) {
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
            One cluster, every app a tenant with its own role and database: the process most of this
            box depends on. Its minors are security fixes, and each is a restart every tenant feels.
          </>
        }
      />

      <BoardGrid>
        <Board
          title="The cluster"
          icon="◱"
          span={8}
          aside={
            <span className={NOTE}>
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
          <p className={FOOT}>
            One cluster, every app a tenant with its own role and database, replacing a postgres
            container per stack. That is why a mid-life restart here is felt everywhere: Pocket ID
            fails its health check the moment it cannot resolve <span className={MONO}>pg</span>,
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
                v: d.up === null ? DASH : d.up ? 'up' : <Chip tone="bad">not answering</Chip>,
              },
              { k: 'Temp files written', v: bytes(d.totals.tempBytes) },
              {
                k: 'Lowest cache hit rate',
                v: worstCache === undefined ? DASH : `${pct(worstCache.cacheHitPct, 2)}`,
              },
              { k: 'in', v: worstCache?.name ?? DASH },
            ]}
          />
          <p className={FOOT}>
            A cache hit rate below about 99% means the cluster is going to disk for pages it should
            have had in memory. Temp bytes are queries that outgrew{' '}
            <span className={MONO}>work_mem</span> and spilled. Both are tuning signals rather than
            faults, and neither shows in the size column.
          </p>
        </Board>

        <TableSection title="Tenants" aside={`${num(d.databases.length)} databases, largest first`}>
          <TenantsTable rows={d.databases} />
          <p className={FOOT}>
            Rollbacks are shown rather than commits because the ratio is what carries information. A
            tenant rolling back a large share of its transactions is either retrying or erroring,
            and neither shows up in its own logs as clearly as it does here. A database that appears
            with no app is one whose stack was removed without dropping it.
          </p>
        </TableSection>

        <Changelog
          gap={d.gap}
          span={12}
          aside={<span className={NOTE}>postgresql.org</span>}
          foot={
            <p className={FOOT}>
              Not from GitHub, unlike every other changelog here: the{' '}
              <span className={MONO}>postgres/postgres</span> mirror carries tags and publishes no
              releases at all, so the usual reader reports the one service on this box whose minors
              are pure security fixes as having nothing to show. These come from{' '}
              <span className={MONO}>postgresql.org/docs/release</span> instead. Only the running
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

/** Database · connections · cache hit · rollbacks · size. The middle steps away first. */
const TENANT_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1.4fr)_6rem_6.5rem_minmax(7rem,1fr)_6rem] @max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.mid]:hidden @max-[40rem]/table:[&>.cache]:hidden'

/** Below this the cluster is going to disk for pages it should hold. */
const CACHE_FLOOR = 99
/** A rollback share above this is a tenant retrying or erroring. */
const ROLLBACK_CEILING = 5

/**
 * One row per tenant database. Every column is quiet until it is not: a cache
 * hit rate under 99%, a rollback share past 5% or any deadlock is the only ink.
 */
function TenantsTable({ rows }: { rows: Postgres['databases'] }) {
  return (
    <ul className={TABLE} aria-label="Tenant databases">
      <li className={cn(TENANT_GRID, TABLE_HEAD)}>
        <span>Database</span>
        <span className="mid text-right">Connections</span>
        <span className="cache text-right">Cache hit</span>
        <span className="mid text-right">Rollbacks</span>
        <span className="text-right">Size</span>
      </li>
      {rows.length === 0 && <li className={TABLE_EMPTY}>the exporter reported no database</li>}
      {rows.map((db) => {
        const txns = (db.commits ?? 0) + (db.rollbacks ?? 0)
        const share = db.rollbacks === null || txns === 0 ? null : (db.rollbacks / txns) * 100
        const cacheLow = db.cacheHitPct !== null && db.cacheHitPct < CACHE_FLOOR
        const rollbackHigh = share !== null && share > ROLLBACK_CEILING
        return (
          <li key={db.name} className={cn(TENANT_GRID, TABLE_ROW_DENSE)}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[0.76rem] text-foreground">{db.name}</span>
              {/* On a phone connections, cache hit and rollbacks are this line. */}
              <span className="hidden text-[0.75rem] text-muted-foreground tabular-nums @max-[40rem]/table:block">
                {num(db.connections)} conn ·{' '}
                <span className={cn(cacheLow && 'text-warning')}>
                  {pct(db.cacheHitPct, 2)} cached
                </span>
                {' · '}
                {(db.deadlocks ?? 0) > 0 ? (
                  <span className="text-warning">{num(db.deadlocks)} deadlocks</span>
                ) : (
                  <span className={cn(rollbackHigh && 'text-warning')}>
                    {num(db.rollbacks)} rollbacks
                  </span>
                )}
              </span>
            </span>
            <span
              className={cn(
                CELL_QUIET,
                'mid text-right',
                (db.connections ?? 0) > 0 && 'text-subdued',
              )}
            >
              {num(db.connections)}
            </span>
            <span className={cn(CELL_QUIET, 'text-right', cacheLow && 'text-warning')}>
              {pct(db.cacheHitPct, 2)}
            </span>
            <span className={cn(CELL_QUIET, 'mid text-right')}>
              {(db.deadlocks ?? 0) > 0 ? (
                <span className="text-warning">{num(db.deadlocks)} deadlocks</span>
              ) : (
                <span
                  className={cn(rollbackHigh && 'text-warning')}
                  title={share === null ? undefined : `${pct(share, 1)} of transactions`}
                >
                  {num(db.rollbacks)}
                  {rollbackHigh && ` · ${pct(share, 0)}`}
                </span>
              )}
            </span>
            <span className="text-right text-foreground tabular-nums">{bytes(db.sizeBytes)}</span>
          </li>
        )
      })}
    </ul>
  )
}
