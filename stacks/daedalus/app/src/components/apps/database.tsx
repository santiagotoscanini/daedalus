import { bytes, DASH } from '../../lib/format'
import type { AppTabData } from '../../server/registry'
import { Bytes } from '../ui'
import { BarList, Board, BoardGrid, Facts, Stat, StatStrip } from '../viz'
import type { AppRecord } from './shared'

/**
 * The app's database on the shared cluster.
 *
 * Read entirely from postgres_exporter, and that is a boundary rather than a
 * shortcut: each app's role can reach its own database and nothing else, so
 * daedalus — which holds credentials for `daedalus` — genuinely cannot connect
 * to anything here. The exporter runs inside the cluster and publishes
 * per-database counters for all of them.
 *
 * So this page shows size, traffic and pressure, and never schema. A table
 * list would mean handing the control plane a connection to every app's data,
 * which is a real boundary traded for a nicer panel.
 */
export function Database({
  app,
  data,
}: {
  app: AppRecord
  data: Extract<AppTabData, { kind: 'database' }>['database']
}) {
  if (!app.postgres) {
    return (
      <p className="lede">
        This app has no database. Turning on Postgres in Settings creates a role and a database on
        the shared cluster and injects <code>DATABASE_URL</code>; nothing else changes.
      </p>
    )
  }

  return (
    <>
      <StatStrip>
        <Stat
          label="Size on disk"
          value={<Bytes value={data.sizeBytes} />}
          spark={data.sizeTrend}
          sub="30 days"
        />
        <Stat
          label="Connections"
          value={data.connections === null ? DASH : String(data.connections)}
          unit={data.maxConnections === null ? '' : `of ${String(data.maxConnections)}`}
          // -1 is postgres's own encoding for "no per-database cap", which is
          // the state every app here is in.
          sub={
            data.connectionLimit === null || data.connectionLimit < 0
              ? 'cluster-wide ceiling'
              : `capped at ${String(data.connectionLimit)}`
          }
        />
        <Stat
          label="Cache hit"
          value={data.cacheHitPct === null ? DASH : data.cacheHitPct.toFixed(1)}
          unit="%"
          // An idle database reads nothing, so there is no ratio to report —
          // a different statement from "0% of reads were cached".
          sub={data.cacheHitPct === null ? 'no reads in 10 min' : 'from shared buffers'}
        />
        <Stat
          label="Transactions"
          value={data.commitsPerSec === null ? DASH : data.commitsPerSec.toFixed(2)}
          unit="/s"
          tone={data.rollbackPct !== null && data.rollbackPct > 5 ? 'bad' : undefined}
          sub={data.rollbackPct === null ? 'idle' : `${data.rollbackPct.toFixed(1)}% rolled back`}
          title={
            data.rollbackPct !== null && data.rollbackPct > 5
              ? 'A high rollback share means the app is erroring, not the database.'
              : undefined
          }
        />
        <Stat
          label="Deadlocks"
          value={data.deadlocks === null ? DASH : data.deadlocks.toLocaleString('en-US')}
          tone={data.deadlocks !== null && data.deadlocks > 0 ? 'bad' : undefined}
          sub="since cluster start"
        />
        <Stat
          label="Temp files"
          value={<Bytes value={data.tempBytes} />}
          sub="spilled past work_mem"
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Connection" icon="◧" span={4}>
          <Facts
            list
            rows={[
              { k: 'cluster', v: 'shared pg' },
              { k: 'database', v: <code>{app.name}</code> },
              { k: 'role', v: <code>{app.name}</code> },
              { k: 'host', v: <code>pg:5432</code> },
              { k: 'injected as', v: <code>DATABASE_URL</code> },
            ]}
          />
          <p className="board-foot">
            The password is machine-generated on the box and never enters git. Rotate it by deleting{' '}
            <code>stacks/app-db/secrets/{app.name}/env</code> and rebuilding.
          </p>
        </Board>

        <Board title="Rows per second" icon="≣" span={4}>
          <Facts
            list
            rows={[
              { k: 'fetched', v: fmtRate(data.tuples.fetched) },
              { k: 'inserted', v: fmtRate(data.tuples.inserted) },
              { k: 'updated', v: fmtRate(data.tuples.updated) },
              { k: 'deleted', v: fmtRate(data.tuples.deleted) },
            ]}
          />
          <p className="board-foot">10-minute average, from the cluster’s own counters.</p>
        </Board>

        <Board title="Against the cluster" icon="rows" span={4}>
          <BarList
            items={data.cluster.map((c) => ({
              label: c.label,
              value: c.value,
              display: bytes(c.value),
              tone: c.label === app.name ? ('accent' as const) : ('muted' as const),
            }))}
            empty="no databases reporting"
          />
          <p className="board-foot">
            Every database on the shared cluster by size, this one highlighted.
          </p>
        </Board>
      </BoardGrid>

      <p className="strip-foot">
        Everything here comes from <code>postgres_exporter</code> on the shared cluster. There is no
        table list or query log because daedalus has no connection to this database — its own role
        can only reach <code>daedalus</code>, and that separation is worth more than the panel would
        be.
      </p>
    </>
  )
}

function fmtRate(v: number | null): string {
  return v === null
    ? '—'
    : v < 1
      ? v.toFixed(2)
      : v.toLocaleString('en-US', { maximumFractionDigits: 1 })
}
