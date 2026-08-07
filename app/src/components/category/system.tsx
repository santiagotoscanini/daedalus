import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Facts,
  Measures,
  Progress,
  Trend,
} from '../viz'
import { LogBoard, type LogNeighbour } from '../logs'
import { DASH, bytes, duration, num, pct, since } from '../../lib/dashboard/format'
import type { SystemData } from '../../server/category'

// The System pages — a tab per layer of the machine.
//
// No ServiceHead on any of them, unlike Media and Home: there is no service
// here to name, no version to compare and no UI to open. The subject is the
// box, so each tab opens straight into the panel that answers its question.
//
// Half the tabs read prometheus and half read a snapshot the host publishes,
// and the pages say which where it matters — a SMART temperature is at most
// ten minutes old, a scrape is sixty seconds old, and on a page about failing
// hardware that difference is worth stating rather than hiding.

export function SystemView({ data }: { data: SystemData }) {
  switch (data.tab) {
    case 'host':
      return <HostView d={data} />
    case 'memory':
      return <MemoryView d={data} />
    case 'disks':
      return <DisksView d={data} />
    case 'pools':
      return <PoolsView d={data} />
    case 'database':
      return <DatabaseView d={data} />
    case 'backups':
      return <BackupsView d={data} />
  }
}

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * The host reader behind Disks, Pools and Backups.
 *
 * A neighbour on exactly the three tabs that depend on it, for the reason
 * `LogNeighbour` exists: when a temperature stops changing or a scrub date
 * goes stale, this is the log that says whether the thing that reads them ran.
 */
const SYSTEM_SNAPSHOT: LogNeighbour = {
  source: { unit: 'daedalus-system-snapshot.service' },
  label: 'System snapshot',
  role: 'where these numbers come from',
  note: 'Runs smartctl, zpool and zfs as root every ten minutes and publishes the result, because this dashboard is a container and none of those three can be run from one. One line per run with the counts. It fails silently from the reader’s side — a stale file shows yesterday’s temperatures as though they were now — so its failures also send mail; see fleet.monitoredJobs in stacks/daedalus.',
}

/** Seconds → a date, computed server-side is not needed: this is a duration. */
function hours(h: number | null): string {
  if (h === null) return DASH
  if (h < 48) return `${String(h)}h`
  const years = h / 24 / 365
  return years >= 1 ? `${years.toFixed(1)}y` : `${String(Math.round(h / 24))}d`
}

/* ── Host ─────────────────────────────────────────────────────────────── */

type Host = Extract<SystemData, { tab: 'host' }>

function HostView({ d }: { d: Host }) {
  return (
    <BoardGrid>
      <Board
        title="Load"
        icon="◔"
        span={8}
        aside={<span className="board-note">{num(d.cores)} threads</span>}
      >
        <Trend values={d.cpuSpark} tone="accent" height={90} />
        <Measures
          items={[
            { k: 'cpu now', v: pct(d.cpuPct, 1) },
            { k: 'load 1m', v: num(d.load.m1, 2) },
            { k: 'load 5m', v: num(d.load.m5, 2) },
            { k: 'load 15m', v: num(d.load.m15, 2) },
          ]}
        />
        <p className="board-foot">
          Six hours of cpu, and the load averages beside it for scale: on {num(d.cores)} threads a
          load of {num(d.cores)} is fully committed, not overloaded. What load cannot tell you is
          what those tasks were waiting FOR, which is the panel to the right.
        </p>
      </Board>

      <Board title="Pressure" icon="⌁" span={4}>
        {/* PSI is the number load average was always a proxy for. Everything
            here is normally zero; the panel exists for the day it is not. */}
        <Facts
          rows={[
            { k: 'CPU stalled', v: pct(d.pressure.cpu, 2) },
            { k: 'I/O stalled', v: pct(d.pressure.io, 2) },
            { k: 'Memory stalled', v: pct(d.pressure.memory, 2) },
          ]}
        />
        <p className="board-foot">
          The share of time in which <em>something</em> was waiting on each resource rather than
          running. Zero is the healthy reading and the usual one; I/O climbing while cpu stays flat
          is a disk problem wearing a performance problem&rsquo;s clothes.
        </p>
      </Board>

      <Board title="Temperature" icon="◉" span={4}>
        <BarList
          items={d.temps.map((t) => ({ ...t, display: `${t.value.toFixed(0)}°` }))}
          tone="info"
          empty="no sensors reporting"
        />
      </Board>

      <Board title="Running" icon="▣" span={4}>
        <Facts
          rows={[
            { k: 'Uptime', v: duration(d.uptimeSeconds) },
            { k: 'Kernel', v: d.kernel === null ? DASH : <span className="mono">{d.kernel}</span> },
            { k: 'Containers', v: num(d.containers.total) },
            {
              k: 'Failed units',
              v:
                d.failedUnits === null ? DASH
                : d.failedUnits > 0 ? <Chip tone="bad">{num(d.failedUnits)}</Chip>
                : <Chip tone="ok">none</Chip>,
            },
          ]}
        />
        {d.containers.down.length > 0 && (
          // Named, not counted — "3 containers down" makes you go hunting.
          <p className="board-foot text-bad">Not answering: {d.containers.down.join(', ')}</p>
        )}
      </Board>

      <Board
        title="Generations"
        icon="⎌"
        span={4}
        aside={<span className="board-note">{num(d.generations.length)} on disk</span>}
      >
        <ul className="itemlist">
          {[...d.generations]
            .reverse()
            .slice(0, 6)
            .map((g) => (
              <li key={g.id}>
                <span className="item-main">
                  #{g.id}
                  {g.current && (
                    <>
                      {' '}
                      <Chip tone="ok">current</Chip>
                    </>
                  )}
                </span>
                <span className="item-side">{g.date}</span>
              </li>
            ))}
        </ul>
        <p className="board-foot">
          The rollback path: reboot and pick one from the systemd-boot menu.{' '}
          <span className="mono">configurationLimit = 10</span> bounds that MENU — it does not prune
          the profile, which is why {num(d.generations.length)} are on disk. They cost store space
          until a garbage collection runs, and nothing here schedules one.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'init.scope' }}
        title="Host journal"
        foot={
          <p className="board-foot">
            PID 1&rsquo;s own stream — unit starts, stops and failures for the whole box. Systemd
            files its &ldquo;Starting&rdquo; and &ldquo;Finished&rdquo; lines here rather than under
            the unit they are about, which is why a oneshot that succeeded looks silent in its own
            log and lands in this one.
          </p>
        }
      />
    </BoardGrid>
  )
}

/* ── Memory ───────────────────────────────────────────────────────────── */

type Memory = Extract<SystemData, { tab: 'memory' }>

function MemoryView({ d }: { d: Memory }) {
  const arcShare =
    d.arc.size === null || d.total === null ? null : (d.arc.size / d.total) * 100

  return (
    <BoardGrid>
      <Board
        title="Memory"
        icon="▤"
        span={8}
        aside={<span className="board-note">{bytes(d.total)} total</span>}
      >
        <Progress
          pct={d.total === null || d.used === null ? null : (d.used / d.total) * 100}
          tone="info"
        />
        <Measures
          items={[
            { k: 'used', v: bytes(d.used) },
            { k: 'available', v: bytes(d.available) },
            { k: 'page cache', v: bytes(d.cached) },
            { k: 'dirty', v: bytes(d.dirty) },
          ]}
        />
        <p className="board-foot">
          Read <b>available</b>, not used. Linux spends free memory on cache by design, so a box
          with nothing to do still reports most of its memory in use — and on this one a large share
          of that is ZFS&rsquo;s cache, which is charged to the kernel and handed back on demand.
        </p>
      </Board>

      <Board title="ZFS cache" icon="◍" span={4}>
        <Progress
          pct={d.arc.size === null || d.arc.max === null ? null : (d.arc.size / d.arc.max) * 100}
          tone="accent"
        />
        <Facts
          rows={[
            { k: 'ARC now', v: bytes(d.arc.size) },
            { k: 'Ceiling', v: bytes(d.arc.max) },
            { k: 'Share of RAM', v: pct(arcShare) },
            { k: 'Hit rate (30m)', v: pct(d.arc.hitRate, 1) },
          ]}
        />
        <p className="board-foot">
          {/* The panel that makes the one to its left readable. */}
          The single biggest consumer on this box and the reason &ldquo;used&rdquo; looks alarming.
          ARC grows to fill what nothing else wants and shrinks under pressure — a high hit rate
          here is what keeps the pools from being asked.
        </p>
      </Board>

      <Board title="zram" icon="⇵" span={4}>
        <Progress
          pct={
            d.zram.total === null || d.zram.used === null || d.zram.total === 0 ?
              null
            : (d.zram.used / d.zram.total) * 100
          }
          tone={(d.zram.used ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <Measures
          items={[
            { k: 'in use', v: bytes(d.zram.used) },
            { k: 'size', v: bytes(d.zram.total) },
          ]}
        />
        <p className="board-foot">
          The only swap on this box — compressed, in RAM, no disk. Bytes in here are memory pressure
          that already happened and that no instantaneous gauge would show.
        </p>
      </Board>

      <Board title="Heaviest containers" icon="▦" span={8}>
        <BarList items={d.topMemory} tone="info" empty="nothing reporting" />
        <p className="board-foot">
          This is <span className="mono">memory.current</span>, which <b>includes page cache</b>. A
          container doing file I/O sits near its limit forever and is perfectly healthy; the cache is
          reclaimed when something else needs it. The number that means a cap is genuinely too tight
          is the OOM counter below, not this bar.
        </p>
      </Board>

      <Board
        title="Caps"
        icon="⊟"
        span={12}
        aside={
          <span className="board-note">
            {num(d.capped.length)} capped · {num(d.uncapped)} not
          </span>
        }
      >
        <Facts
          rows={[
            {
              k: 'OOM kills, all time',
              v:
                d.oomKills === null ? DASH
                : d.oomKills > 0 ? <span className="text-warn">{num(d.oomKills)}</span>
                : <Chip tone="ok">none</Chip>,
            },
          ]}
        />
        {d.capped.length === 0 ?
          <p className="viz-empty">No container has a memory cap.</p>
        : <ul className="itemlist">
            {d.capped.map((c) => (
              <li key={c.name}>
                <span className="item-main mono">{c.name}</span>
                <span className="item-side">{bytes(c.usageBytes)} in use</span>
                <span className="item-n">{bytes(c.limitBytes)}</span>
              </li>
            ))}
          </ul>
        }
        <p className="board-foot">
          A cap is only enforced because systemd delegates <span className="mono">memory</span> to
          the rootless user slice — without that podman accepts the flag and the kernel ignores it.
          The module always emits <span className="mono">--memory-swap</span> equal to{' '}
          <span className="mono">--memory</span>: podman writes that value verbatim and defaults it
          to twice the limit, so a cap set alone would kill at three times what it says.{' '}
          {num(d.uncapped)} containers have no cap at all, which is the platform default — a
          silently-capped app is one that dies at 3am for a reason nobody wrote down.
        </p>
      </Board>
    </BoardGrid>
  )
}

/* ── Disks ────────────────────────────────────────────────────────────── */

type Disks = Extract<SystemData, { tab: 'disks' }>

function DisksView({ d }: { d: Disks }) {
  const io = new Map(d.io.map((i) => [i.device, i]))

  return (
    <BoardGrid>
      {d.disks.length === 0 && (
        <Board title="Disks" icon="▦" span={12}>
          <p className="viz-empty">
            No snapshot yet — the host reader has not run, or could not read SMART.
          </p>
        </Board>
      )}

      {d.disks.map((disk) => {
        const nvme = disk.percentageUsed !== null
        const stats = io.get(disk.device)
        const failedTest = disk.selfTests.find((t) => !t.passed)

        return (
          <Board
            key={disk.device}
            title={disk.device}
            icon={nvme ? '⚡' : '▦'}
            span={6}
            aside={
              disk.passed === null ? <span className="board-note">no SMART</span>
              : disk.passed ? <Chip tone="ok">SMART ok</Chip>
              : <Chip tone="bad">SMART failing</Chip>
            }
          >
            <p className="board-note">
              {disk.model ?? '?'}
              {disk.serial !== null && <span className="mono"> · {disk.serial}</span>}
            </p>

            <Measures
              items={[
                { k: 'temperature', v: disk.temperature === null ? DASH : `${String(disk.temperature)}°` },
                { k: 'powered on', v: hours(disk.powerOnHours) },
                { k: 'power cycles', v: num(disk.powerCycles) },
                {
                  k: nvme ? 'endurance used' : 'reallocated',
                  v: nvme ? pct(disk.percentageUsed) : num(disk.reallocated),
                },
              ]}
            />

            <h4 className="board-sub">What would fail first</h4>
            <Facts
              rows={
                nvme ?
                  [
                    { k: 'Spare blocks', v: pct(disk.spareAvailable) },
                    { k: 'Media errors', v: num(disk.mediaErrors) },
                    { k: 'Unsafe shutdowns', v: num(disk.unsafeShutdowns) },
                    {
                      k: 'Critical warning',
                      v:
                        disk.criticalWarning === null ? DASH
                        : disk.criticalWarning === 0 ? <Chip tone="ok">none</Chip>
                        : <Chip tone="bad">{num(disk.criticalWarning)}</Chip>,
                    },
                  ]
                : [
                    { k: 'Reallocated sectors', v: num(disk.reallocated) },
                    { k: 'Pending sectors', v: num(disk.pending) },
                    { k: 'Offline uncorrectable', v: num(disk.uncorrectable) },
                    {
                      k: 'Link CRC errors',
                      v:
                        disk.crcErrors === null ? DASH
                        : disk.crcErrors > 0 ? <span className="text-warn">{num(disk.crcErrors)}</span>
                        : num(disk.crcErrors),
                    },
                  ]
              }
            />
            {!nvme && (disk.crcErrors ?? 0) > 0 && (
              // The distinction that decides what you'd actually do about it.
              <p className="board-foot text-warn">
                A link CRC error is the <em>cable</em>, not the platter — a transfer that had to be
                retried between the controller and the drive. It never decrements, so this is a
                lifetime count and a stable one is nothing; a climbing one means reseating a SATA
                cable, not replacing a disk.
              </p>
            )}

            <h4 className="board-sub">Self-tests</h4>
            <ul className="itemlist">
              {disk.selfTests.slice(0, 5).map((t, i) => (
                <li key={`${t.type ?? '?'}-${String(t.hours ?? i)}-${String(i)}`}>
                  <span className="item-main">{t.type ?? '?'}</span>
                  <span className="item-side">
                    {t.passed ?
                      <Chip tone="ok">ok</Chip>
                    : <Chip tone="warn">{t.status ?? 'failed'}</Chip>}
                  </span>
                  <span className="item-side">
                    {/* Against the drive's CURRENT hours, because the drive has
                        no calendar — it counts hours, not dates. */}
                    {t.hours === null || disk.powerOnHours === null ?
                      DASH
                    : `${hours(disk.powerOnHours - t.hours)} ago`}
                  </span>
                </li>
              ))}
              {disk.selfTests.length === 0 && <p className="viz-empty">no tests on record</p>}
            </ul>

            {stats !== undefined && (
              <>
                <h4 className="board-sub">Throughput, 5-minute average</h4>
                <Measures
                  items={[
                    { k: 'read', v: `${bytes(stats.readBytes)}/s` },
                    { k: 'written', v: `${bytes(stats.writtenBytes)}/s` },
                    { k: 'busy', v: pct(stats.utilPct, 1) },
                  ]}
                />
              </>
            )}

            {failedTest !== undefined && (
              <p className="board-foot text-warn">
                The most recent <b>{failedTest.type ?? 'test'}</b> did not finish:{' '}
                {failedTest.status ?? 'unknown'}. An interrupted test is not a failing disk — a host
                reset or a power event ends one — but it does mean that scheduled check did not
                actually verify anything.
              </p>
            )}
          </Board>
        )
      })}

      <Board title="How these are tested" icon="✓" span={12}>
        <Facts
          rows={[
            { k: 'Short self-test', v: 'every Saturday, 02:00' },
            { k: 'Extended self-test', v: 'the 1st of each month, 03:00' },
            {
              k: 'smartd',
              v:
                d.smartdActive === null ? DASH
                : d.smartdActive ? <Chip tone="ok">running</Chip>
                : <Chip tone="bad">not running</Chip>,
            },
          ]}
        />
        <p className="board-foot">
          Autodetected across every disk, with no per-drive configuration — the schedule is one
          string in <span className="mono">platform/smartd.nix</span>. A drive that reports
          pre-failure sends mail, wired in <span className="mono">platform/mail</span>. The results
          above are read back off each drive&rsquo;s own log rather than from that schedule, so a
          test that was configured and never ran shows as an absence here.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'smartd.service' }}
        title="smartd"
        neighbours={[SYSTEM_SNAPSHOT]}
        foot={
          <p className="board-foot">
            The daemon that runs the tests above and watches every attribute between them. Quiet is
            correct; it speaks when an attribute crosses its threshold.
          </p>
        }
      />
    </BoardGrid>
  )
}

/* ── Pools ────────────────────────────────────────────────────────────── */

type Pools = Extract<SystemData, { tab: 'pools' }>

function PoolsView({ d }: { d: Pools }) {
  return (
    <BoardGrid>
      {d.pools.map((p) => (
        <Board
          key={p.name}
          title={p.name}
          icon="◫"
          span={6}
          aside={
            p.health === 'ONLINE' ? <Chip tone="ok">online</Chip> : <Chip tone="bad">{p.health}</Chip>
          }
        >
          <Progress pct={p.capacityPct} tone={p.capacityPct > 80 ? 'warn' : 'info'} />
          <Measures
            items={[
              { k: 'used', v: bytes(p.allocBytes) },
              { k: 'free', v: bytes(p.freeBytes) },
              { k: 'capacity', v: pct(p.capacityPct) },
              { k: 'fragmentation', v: pct(p.fragPct) },
            ]}
          />

          <h4 className="board-sub">Devices</h4>
          <ul className="itemlist">
            {p.vdevs.map((v) => (
              <li key={v.name}>
                <span className="item-main mono" title={v.name}>
                  {v.name}
                </span>
                <span className="item-side">
                  {v.state === 'ONLINE' ? <Chip tone="ok">online</Chip> : <Chip tone="warn">{v.state ?? '?'}</Chip>}
                </span>
              </li>
            ))}
          </ul>

          <h4 className="board-sub">Last scrub</h4>
          {p.scrub === null ?
            <p className="viz-empty">never scrubbed</p>
          : <Facts
              rows={[
                {
                  k: 'Result',
                  v:
                    (p.scrub.errors ?? 0) === 0 ?
                      <Chip tone="ok">no errors</Chip>
                    : <Chip tone="bad">{num(p.scrub.errors)} errors</Chip>,
                },
                {
                  k: 'Finished',
                  v:
                    p.scrub.endedAt === null ? DASH
                    : since(Date.now() / 1000 - p.scrub.endedAt),
                },
                {
                  k: 'Took',
                  v:
                    p.scrub.startedAt === null || p.scrub.endedAt === null ?
                      DASH
                    : duration(p.scrub.endedAt - p.scrub.startedAt),
                },
                { k: 'Read', v: bytes(p.scrub.examined) },
              ]}
            />
          }
          <p className="board-foot">
            Monthly, and it is the only thing that finds bit-rot: ZFS checksums every block on read,
            but a block nobody reads is never checked. On the mirror a bad copy is repaired from the
            good one; on the single-device pool a scrub can only report.
          </p>
        </Board>
      ))}

      <Board
        title="Datasets"
        icon="▤"
        span={12}
        aside={
          <span className="board-note">
            {bytes(d.snapshotBytes)} in {num(d.snapshots)} snapshots
          </span>
        }
      >
        <ul className="itemlist">
          {d.datasets.map((ds) => (
            <li key={ds.name}>
              <span className="item-main mono">{ds.name}</span>
              <span className="item-side">
                {ds.snapshots === 0 ? 'not snapshotted' : `${String(ds.snapshots)} snapshots`}
              </span>
              <span className="item-side">{bytes(ds.snapshotBytes)} in them</span>
              <span className="item-n">{bytes(ds.usedBytes)}</span>
            </li>
          ))}
        </ul>
        <p className="board-foot">
          <b>Used</b> is the dataset plus everything its snapshots still pin;{' '}
          <b>in them</b> is that second part alone — data no longer live but held because a snapshot
          references it. That column is the one to watch on{' '}
          <span className="mono">rpool/selfhost</span>: 16K recordsize under every container&rsquo;s
          database means its deltas are larger than intuition suggests, and the remedy if it grows
          is dropping a snapshot tier in <span className="mono">platform/zfs.nix</span>. The tiers
          are ring buffers — count times cadence IS the retention window — so a fully enrolled
          dataset settles at 39.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'zfs-converge.service' }}
        title="zfs-converge"
        neighbours={[
          SYSTEM_SNAPSHOT,
          {
            source: { unit: 'zfs-scrub.service' },
            label: 'Scrub',
            role: 'the monthly read of every block',
            note: 'Quiet unless it finds something. A missed run is the failure mode that matters, so this one is a dead-man’s-switch ping rather than a failure email — it reports to healthchecks and pages if it stops running entirely.',
          },
        ]}
        foot={
          <p className="board-foot">
            Diffs the live dataset properties against the declaration on every rebuild and{' '}
            <span className="mono">zfs set</span>s only where they differ, so a silent run means
            reality already matched. It is wanted-by rather than required-by the mounts on purpose:
            a failed converge must never block <span className="mono">/s2</span>, and with it most
            of the container fleet.
          </p>
        }
      />
    </BoardGrid>
  )
}

/* ── Database ─────────────────────────────────────────────────────────── */

type Database = Extract<SystemData, { tab: 'database' }>

function DatabaseView({ d }: { d: Database }) {
  const worstCache = [...d.databases]
    .filter((x) => x.cacheHitPct !== null)
    .sort((a, b) => (a.cacheHitPct ?? 0) - (b.cacheHitPct ?? 0))[0]

  return (
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
          One cluster, every app a tenant with its own role and database — the consolidation that
          replaced a postgres container per stack. That is why a mid-life restart here is felt
          everywhere: Pocket ID fails its health check the moment it cannot resolve{' '}
          <span className="mono">pg</span>, and every SSO app follows it down.{' '}
          <b>Longest transaction</b> is the stuck-query signal — a number that climbs and does not
          reset is something holding a lock nobody is waiting on any more.
        </p>
      </Board>

      <Board title="Serving from" icon="◍" span={4}>
        <Facts
          rows={[
            {
              k: 'Status',
              v:
                d.up === null ? DASH
                : d.up ? <Chip tone="ok">up</Chip>
                : <Chip tone="bad">not answering</Chip>,
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
          <span className="mono">work_mem</span> and spilled — both are tuning signals rather than
          faults, and both are invisible in the size column.
        </p>
      </Board>

      <Board title="Tenants" icon="▤" span={12}>
        <ul className="itemlist">
          {d.databases.map((db) => (
            <li key={db.name}>
              <span className="item-main mono">{db.name}</span>
              <span className="item-side">{num(db.connections)} conn</span>
              <span className="item-side">{pct(db.cacheHitPct, 2)} cached</span>
              <span className="item-side">
                {(db.deadlocks ?? 0) > 0 ?
                  <span className="text-warn">{num(db.deadlocks)} deadlocks</span>
                : `${num(db.rollbacks)} rollbacks`}
              </span>
              <span className="item-n">{bytes(db.sizeBytes)}</span>
            </li>
          ))}
        </ul>
        <p className="board-foot">
          Rollbacks are shown rather than commits because the ratio is what carries information — a
          tenant rolling back a large share of its transactions is either retrying or erroring, and
          neither shows up in its own logs as clearly as it does here. A database that appears with
          no app is one whose stack was removed without dropping it.
        </p>
      </Board>

      <LogBoard
        source={{ stack: 'app-db' }}
        title="Cluster logs"
        neighbours={[
          {
            source: { unit: 'app-db-bootstrap.service' },
            label: 'Bootstrap',
            role: 'what creates a tenant’s role and database',
            note: 'Materialises one role, one database and one env file per fleet.appDatabases entry, generating the password on the box rather than in the store. An app that suddenly cannot connect after being declared is usually this not having run — every tenant is ordered after it, and after podman-pg itself, so a mass restart re-queues them.',
          },
        ]}
      />
    </BoardGrid>
  )
}

/* ── Backups ──────────────────────────────────────────────────────────── */

type Backups = Extract<SystemData, { tab: 'backups' }>

function BackupsView({ d }: { d: Backups }) {
  return (
    <BoardGrid>
      <Board
        title="Replication"
        icon="⇉"
        span={8}
        aside={<span className="board-note">{bytes(d.totalReplicatedBytes)} on the mirror</span>}
      >
        {d.pairs.length === 0 ?
          <p className="viz-empty">no replication pairs found</p>
        : <ul className="itemlist">
            {d.pairs.map((p) => (
              <li key={p.target}>
                <span className="item-main mono">{p.source}</span>
                <span className="item-side mono">→ {p.target}</span>
                <span className="item-side">{num(p.targetSnapshots)} snapshots</span>
                <span className="item-n">
                  {p.lagSeconds === null ?
                    DASH
                  : p.lagSeconds > 7200 ?
                    <span className="text-warn">{duration(p.lagSeconds)} behind</span>
                  : `${duration(p.lagSeconds)} behind`}
                </span>
              </li>
            ))}
          </ul>
        }
        <p className="board-foot">
          syncoid runs hourly and rides the existing auto-snapshots rather than cutting its own, so
          a lag under an hour is the schedule rather than a fault — the source takes a snapshot every
          fifteen minutes and the replica catches the hourly one. It is a <b>mirror, not an
          archive</b>: it prunes whatever the source pruned, so a manual snapshot you keep on the
          source dies on the replica the moment its original is destroyed. That is also why the lag
          is the reading and &ldquo;the target has snapshots&rdquo; is not — syncoid exits 0 on a
          run that copied nothing.
        </p>
      </Board>

      <Board title="What is not covered" icon="⚠" span={4}>
        {/* The honest half, and the reason this is a tab rather than a panel
            on Pools. Everything above is easy to show and easy to believe. */}
        <ul className="itemlist">
          <li>
            <span className="item-main">Off-site</span>
            <span className="item-side">nothing</span>
          </li>
          <li>
            <span className="item-main mono">acme.json</span>
            <span className="item-side">Let&rsquo;s Encrypt cert store</span>
          </li>
          <li>
            <span className="item-main mono">gravity.db</span>
            <span className="item-side">pi-hole&rsquo;s UI-added lists</span>
          </li>
        </ul>
        <p className="board-foot">
          Both pools are in this box, on this shelf. The mirror survives a drive; it does not survive
          a fire, a theft or a mistake that reaches both pools. The two files below it are outside
          the snapshot tree entirely — losing the cert store means re-issuing against Let&rsquo;s
          Encrypt&rsquo;s weekly rate limit. This is the biggest gap on the machine and it is stated
          here rather than left to be discovered.
        </p>
      </Board>

      <Board
        title="Snapshot coverage"
        icon="◷"
        span={8}
        aside={<span className="board-note">{num(d.coverage.length)} enrolled</span>}
      >
        <ul className="itemlist">
          {d.coverage.map((c) => (
            <li key={c.name}>
              <span className="item-main mono">{c.name}</span>
              <span className="item-side">{num(c.snapshots)} snapshots</span>
              <span className="item-n">{bytes(c.usedBytes)}</span>
            </li>
          ))}
        </ul>
      </Board>

      <Board title="Deliberately not snapshotted" icon="○" span={4}>
        {d.unsnapshotted.length === 0 ?
          <p className="viz-empty">every dataset is enrolled</p>
        : <ul className="itemlist">
            {d.unsnapshotted.map((u) => (
              <li key={u.name}>
                <span className="item-main mono">{u.name}</span>
                <span className="item-n">{bytes(u.usedBytes)}</span>
              </li>
            ))}
          </ul>
        }
        <p className="board-foot">
          Opted out per dataset with{' '}
          <span className="mono">com.sun:auto-snapshot=false</span>. The media library is the big
          one and the reasoning is that it is re-downloadable — snapshotting a terabyte of files that
          can be fetched again buys nothing and costs the deltas.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'syncoid-rpool-selfhost.service' }}
        title="syncoid — selfhost"
        neighbours={[
          {
            source: { unit: 'syncoid-rpool-home.service' },
            label: 'syncoid — home',
            role: 'the other replication pair',
            note: 'Same schedule and the same flags. Both run --quiet, which drops syncoid’s progress-meter stage: the bundled pv aborts intermittently under headless piping and a crashed pv breaks the pipe and fails the whole replication.',
          },
          SYSTEM_SNAPSHOT,
        ]}
        foot={
          <p className="board-foot">
            Failures send mail; a run that stops happening at all pages through healthchecks, which
            is the failure this cannot detect itself. Both are declared in{' '}
            <span className="mono">platform/backup.nix</span>.
          </p>
        }
      />
    </BoardGrid>
  )
}
