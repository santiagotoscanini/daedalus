import {
  BarList,
  Board,
  BoardGrid,
  BigStat,
  Columns,
  Facts,
  Progress,
  Pulse,
  StatBand,
  Trend,
} from '../viz'
import { DASH, bytes, num, since } from '../../lib/dashboard/format'
import type { SystemData } from '../../server/category'

// The System page: the machine itself.
//
// Leads with the four readings that would make you stop what you are doing —
// something failed, something is down, something is full, something got hot —
// and only then shows the gauges. A vitals page that opens with a CPU graph
// buries the one line that matters on a day when it matters.

export function SystemView({ data }: { data: SystemData }) {
  const { host, pools, containers, health, logs } = data
  const trouble =
    (health.failedUnits ?? 0) + (health.firingAlerts ?? 0) + containers.down.length +
    (health.probesDown ?? 0)

  return (
    <>
      <StatBand>
        <BigStat
          label="Needs attention"
          value={num(trouble)}
          tone={trouble > 0 ? 'bad' : 'ok'}
          sub={
            trouble === 0 ?
              'everything green'
            : `${num(health.failedUnits)} units · ${num(health.firingAlerts)} alerts · ${String(
                containers.down.length,
              )} containers`
          }
        />
        <BigStat
          label="CPU"
          value={host.cpuPct === null ? DASH : host.cpuPct.toFixed(0)}
          unit="%"
          spark={host.cpuSpark}
          sub={`${num(host.cores)} cores · load ${num(host.load1, 2)}`}
        />
        <BigStat
          label="Memory"
          value={bytes(host.memUsed)}
          tone="info"
          sub={`of ${bytes(host.memTotal)}`}
        />
        <BigStat
          label="Uptime"
          value={host.uptimeSeconds === null ? DASH : (host.uptimeSeconds / 86400).toFixed(1)}
          unit="days"
          tone="muted"
          sub={`${num(containers.total)} containers`}
        />
      </StatBand>

      <BoardGrid>
        <Board title="Health" icon="◔" span={6}>
          <Facts
            rows={[
              {
                k: 'Failed systemd units',
                v: tone(health.failedUnits, (v) => v > 0),
              },
              { k: 'Firing alert rules', v: tone(health.firingAlerts, (v) => v > 0) },
              {
                k: 'Probes',
                v: `${num(health.probesUp)} up · ${num(health.probesDown)} down`,
              },
              {
                k: 'Uptime, 24h',
                v: health.uptime24h === null ? DASH : `${health.uptime24h.toFixed(2)}%`,
              },
              {
                k: 'Scheduled jobs',
                v:
                  health.checks === null ?
                    DASH
                  : `${String(health.checks.up)} up · ${String(health.checks.down)} down · ${String(
                      health.checks.late,
                    )} late`,
              },
              {
                k: 'OOM kills, lifetime',
                v: tone(containers.oomKills, (v) => v > 0),
              },
            ]}
          />
          {containers.down.length > 0 && (
            <p className="board-foot text-bad">Not running: {containers.down.join(', ')}</p>
          )}
        </Board>

        <Board title="Pools" icon="▤" span={6}>
          <ul className="pools">
            {pools.map((p) => {
              const used = (p.usedBytes / Math.max(1, p.totalBytes)) * 100
              return (
                <li key={p.name} className="pools-row">
                  <div className="pools-head">
                    <span className="pools-name">
                      <Pulse on={p.healthy === true} tone={p.healthy === true ? 'ok' : 'bad'} />
                      {p.name}
                    </span>
                    <span className="pools-meta">
                      {bytes(p.usedBytes)} of {bytes(p.totalBytes)} · {used.toFixed(0)}%
                    </span>
                  </div>
                  <Progress
                    pct={used}
                    tone={used > 90 ? 'bad' : used > 75 ? 'warn' : 'ok'}
                    height={8}
                  />
                </li>
              )
            })}
          </ul>
          {pools.length === 0 && <p className="viz-empty">no ZFS filesystems reporting</p>}
          {/* Every dataset in a pool reports the same free space — that is how
              ZFS works — so used is summed per dataset and free is taken once. */}
          <p className="board-foot">
            Datasets in a pool share their free space; used is summed across them.
          </p>
        </Board>

        <Board title="Load" icon="◑" span={6}>
          <Trend values={host.cpuSpark} height={80} />
          <Facts
            rows={[
              { k: 'Load 1 / 5 / 15', v: `${num(host.load1, 2)} · ${num(host.load5, 2)} · ${num(host.load15, 2)}` },
              { k: 'Memory used', v: `${bytes(host.memUsed)} of ${bytes(host.memTotal)}` },
              // zram is the only swap on this box; bytes in it are memory
              // pressure that already happened and no live gauge would show.
              { k: 'In zram swap', v: bytes(host.zramUsed) },
              { k: 'Booted', v: since(host.uptimeSeconds) },
            ]}
          />
        </Board>

        <Board title="Temperature" icon="◈" span={6}>
          <div className="temps">
            {data.temps.map((t) => (
              <span
                key={t.label}
                className={t.value > 70 ? 'temps-item temps-hot' : 'temps-item'}
              >
                <strong>{t.value.toFixed(0)}°</strong>
                <em title={t.label}>{t.label}</em>
              </span>
            ))}
          </div>
          {data.temps.length === 0 && <p className="viz-empty">no sensors reporting</p>}
        </Board>

        <Board
          title="Heaviest containers"
          icon="▦"
          span={6}
          aside={<span className="board-note">memory, page cache included</span>}
        >
          <BarList items={containers.topMemory} tone="info" />
          <h4 className="board-sub">CPU, 5 min average</h4>
          <BarList items={containers.topCpu} />
          {/* memory.current includes page cache, so a container doing file I/O
              sits at its limit forever and is perfectly healthy. The signal a
              cap is too tight is the OOM counter moving, not usage. */}
          <p className="board-foot">
            Sitting at a limit is normal — page cache is charged there and reclaimed under
            pressure. The OOM counter is the real signal.
          </p>
        </Board>

        <Board
          title="Logs"
          icon="≡"
          span={6}
          aside={<span className="board-note">errors per hour, 24h</span>}
        >
          <Columns
            points={data.logs.errorHistory.map((v, i) => ({
              label: `${String(data.logs.errorHistory.length - i)}h ago`,
              value: v,
            }))}
            tone="bad"
            height={70}
          />
          <Facts
            rows={[
              { k: 'Lines, last hour', v: num(logs.lines1h) },
              { k: 'Warnings', v: num(logs.warn1h) },
              { k: 'Errors', v: tone(logs.errors1h, (v) => v > 0) },
            ]}
          />
          <h4 className="board-sub">Noisiest, 24h</h4>
          <BarList items={logs.noisiest} tone="bad" empty="no errors logged" />
        </Board>

        <Board title="Databases" icon="◱" span={12}>
          <BarList items={data.databases} tone="info" empty="no databases reporting" />
          <p className="board-foot">
            All on the shared cluster. Sizes are on-disk, including indexes and bloat.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

/** A count that should read as trouble only when it is not zero. */
function tone(value: number | null, bad: (v: number) => boolean) {
  if (value === null) return DASH
  return bad(value) ? <span className="text-bad">{num(value)}</span> : num(value)
}
