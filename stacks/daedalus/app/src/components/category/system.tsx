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
import { Changelog } from '../release-notes'
import { compareOf, ServiceHead, verdictOf } from '../service-head'
import { DASH, bytes, duration, num, pct, since } from '../../lib/dashboard/format'
import type { SystemData } from '../../server/category'

// The System pages — a tab per layer of the machine.
//
// No ServiceHead on five of the six, unlike Media and Home: there is no
// service to name, no version to compare and no UI to open. The subject is the
// box, so each tab opens straight into the panel that answers its question.
// That is declared per tab in lib/dashboard/nav.ts (`head: false`) rather than
// merely omitted here, because the SKELETON has to know it before the data
// exists — see the note there.
//
// Database is the exception, and a real one rather than an inconsistency: its
// subject is postgres, which has a version, a release cycle, and minors that
// are almost entirely security and data-corruption fixes. Treating the one
// process every app on this box depends on as a "layer of the machine" is what
// kept the cluster's own upgrade state off this dashboard entirely.
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
    case 'build':
      return <BuildView d={data} />
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

/**
 * The two readers behind Host and Memory.
 *
 * Same argument as `SYSTEM_SNAPSHOT` and the same gap: every number on those
 * two tabs comes from one of these, and until now neither one's log was
 * reachable from anywhere in this dashboard — so a gauge that had quietly
 * stopped moving looked exactly like a machine that had quietly gone idle.
 */
const HOST_READERS: readonly LogNeighbour[] = [
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the host’s own numbers',
    note: 'CPU, load, memory, pressure stall, filesystems, hwmon temperatures and the NIC counters. It runs on --network=host because it reads the real /proc, /sys and interfaces — a bridge namespace would show it the container’s, which is why this is one of the few containers here with a published port rather than a traefik-net address.',
  },
  {
    source: { unit: 'host-liveness-exporter.service' },
    label: 'host-liveness-exporter',
    role: 'per-container CPU, memory and OOM kills',
    note: 'A timer, not a daemon: every 60s it walks the rootless cgroup tree under user@1000.service that no packaged exporter can see, and writes the result as a textfile for node-exporter to serve. That 60s tick is also why the per-container numbers here are quantised — a short rate window over them is reading the timer, not the workload. A container that vanishes from these panels is usually this not having run.',
  },
]

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

      {/* The machine itself, on the tab about the machine itself. It carries
          no reading and is not trying to: every other panel here is a number
          that moves, and this is the one thing on the page you could put a
          hand on. The specification lives on Build — this is recognition, and
          a link to the rest. */}
      <Board title="The box" icon="▣" span={4}>
        <div className="part">
          <PartPhoto part={PARTS.case} />
          <div className="part-id">
            <strong className="part-name">{PARTS.case.name}</strong>
            <span className="part-detail">
              {d.kernel === null ? 'kernel unread' : `Linux ${d.kernel}`}, up{' '}
              {duration(d.uptimeSeconds)}.
            </span>
          </div>
        </div>
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
        neighbours={HOST_READERS}
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

      {/* The sticks behind the bar above. Every other number on this tab is
          bytes in flight; this is what they are flying through, and it is the
          only panel here that answers "can I add more" — which is the question
          a memory page gets asked when the bar looks full. */}
      <Board
        title="The modules"
        icon="▤"
        span={4}
        aside={
          <span className="board-note">
            {d.modules.populated === null || d.modules.slots === null ?
              DASH
            : `${num(d.modules.populated)} of ${num(d.modules.slots)} slots`}
          </span>
        }
      >
        <PartHead part={PARTS.memory} />
        <Facts
          rows={[
            {
              k: 'Installed',
              v:
                d.modules.totalGb === null ? DASH : (
                  `${num(d.modules.totalGb)} GB ${d.modules.modules[0]?.type ?? ''}`.trim()
                ),
            },
            {
              k: 'Speed',
              v:
                d.modules.modules[0]?.speedMts == null ?
                  DASH
                : `${num(d.modules.modules[0].speedMts)} MT/s`,
            },
            {
              k: 'Part',
              v: <span className="mono">{d.modules.modules[0]?.partNumber ?? DASH}</span>,
            },
            {
              k: 'Room left',
              v:
                d.modules.maxCapacityGb === null || d.modules.totalGb === null ?
                  DASH
                : `${num(d.modules.maxCapacityGb - d.modules.totalGb)} GB in ${num(
                    (d.modules.slots ?? 0) - (d.modules.populated ?? 0),
                  )} slots`,
            },
          ]}
        />
        <p className="board-foot">
          Read from SMBIOS rather than counted from bytes — the kernel knows how much memory it
          has and nothing about how it arrives. Two slots free against a 128 GB ceiling is the
          headroom this machine actually has, and the full specification is on <b>Build</b>.
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

      {/* This was the one tab in the whole dashboard with no log at all, which
          made it the one page whose numbers could not be checked against
          anything. The kernel is the right stream: an OOM kill, a zram
          allocation failure and ZFS shrinking the ARC under pressure are all
          kernel lines and appear in no container's log — including the log of
          the container that was killed. */}
      <LogBoard
        source={{ stack: 'kernel' }}
        title="Kernel"
        neighbours={HOST_READERS}
        foot={
          <p className="board-foot">
            Kernel lines carry no unit and no container, so alloy labels them{' '}
            <span className="mono">stack=kernel</span> — this is the stream an OOM kill actually
            lands in. The counter on the panel above says one happened; this says which cgroup was
            chosen, how much it was holding, and what the machine was doing at the time, none of
            which survives in the killed container&rsquo;s own log.
          </p>
        }
      />
    </BoardGrid>
  )
}

/* ── Disks ────────────────────────────────────────────────────────────── */

type Disks = Extract<SystemData, { tab: 'disks' }>

/**
 * The drive in the picture, matched on the model string SMART reports.
 *
 * Same argument as the router's photograph on Network: these panels are about
 * physical objects in the house, and a 3.5" platter drive and an M.2 stick are
 * not interchangeable in any way that matters when you are about to open the
 * case. Nothing infers a photo from `rotationRate` — a stock image of "a hard
 * disk" would be decoration, and a wrong one would be worse than none, so an
 * unrecognised model gets no picture and the panel reads exactly as before.
 *
 * The intrinsic dimensions are the files' own, so the aspect ratio is reserved
 * before the image loads and nothing below it jumps.
 */
type DiskPhoto = { src: string; width: number; height: number; shape: 'platter' | 'stick' }

const DISK_PHOTOS: readonly { model: string; photo: DiskPhoto }[] = [
  {
    model: 'ST16000NE000',
    photo: { src: '/disk-ironwolf-pro.png', width: 480, height: 696, shape: 'platter' },
  },
  {
    model: 'Samsung SSD 990 PRO',
    photo: { src: '/disk-990-pro.webp', width: 700, height: 346, shape: 'stick' },
  },
]

function diskPhoto(model: string | null): DiskPhoto | null {
  if (model === null) return null
  return DISK_PHOTOS.find((d) => model.includes(d.model))?.photo ?? null
}

/**
 * What Seagate's class code says the drive is.
 *
 * The two letters after the capacity are the only part of the part number
 * that changes what the drive IS, and the difference that matters here is
 * the workload rate limit: NE and NT are both "IronWolf Pro" on the label
 * and on the box, and they are rated 300 and 500 TB/year respectively. That
 * is the number to check a part number against before buying a replacement,
 * and it is nowhere on this page otherwise.
 */
const SEAGATE_CLASSES: Record<string, { line: string; note: string }> = {
  NE: { line: 'IronWolf Pro', note: 'NAS, rated 300 TB/year of reads and writes' },
  NT: { line: 'IronWolf Pro', note: 'NAS, rated 500 TB/year — the same label as NE, a higher limit' },
  VN: { line: 'IronWolf', note: 'NAS, rated 180 TB/year' },
  NM: { line: 'Exos', note: 'enterprise, rated 550 TB/year' },
  VX: { line: 'SkyHawk', note: 'surveillance — tuned for many sequential write streams' },
  DM: { line: 'BarraCuda', note: 'desktop — no NAS vibration handling, no workload rating' },
}

/**
 * `key` drives the colour, and the colours are not decorative.
 *
 * Everywhere else on this dashboard a colour means a fault, so five rotating
 * hues over a part number would spend the one signal the palette has on
 * something that is never wrong. Instead the segments alternate between plain
 * and dimmed so their boundaries read, and exactly one — the class code —
 * takes the accent, because it is the only segment whose value changes what
 * you would buy.
 */
type Segment = {
  key: 'maker' | 'capacity' | 'class' | 'variant' | 'config'
  text: string
  label: string
  note: string
}

/**
 * A part number that explains itself on hover.
 *
 * The string is the drive's identity and it is unreadable — `ST16000NE000` is
 * five separate facts run together, and the one that decides whether a
 * replacement is the same drive (the workload rating) is two letters in the
 * middle. Colouring the segments makes it legible at a glance; the card makes
 * it readable.
 *
 * Positioned inside the board rather than floating above the page, because
 * `.board` is `overflow: hidden` and anything escaping it would be clipped
 * rather than shown. It overlays the panel below it, which is what a tooltip
 * does anyway, and it needs no positioning library to do it.
 *
 * `tabIndex` and `:focus-within` alongside `:hover` so this is reachable
 * without a pointer — a hover-only disclosure is one that a keyboard, and a
 * phone, simply cannot open.
 */
function ModelDecode({ model, segments }: { model: string; segments: Segment[] }) {
  return (
    <span className="decode" tabIndex={0} aria-label={`${model}, decoded`}>
      <strong className="disk-model decode-string">
        {segments.map((s, i) => (
          <span key={`${s.text}-${String(i)}`} className={`decode-seg decode-seg-${s.key}`}>
            {s.text}
          </span>
        ))}
      </strong>
      <span className="decode-card" role="tooltip">
        <span className="decode-head">{model}</span>
        <ul className="decode-list">
          {segments.map((s, i) => (
            <li key={`${s.text}-${String(i)}`}>
              <code className={`decode-seg decode-seg-${s.key}`}>{s.text}</code>
              <span className="decode-label">{s.label}</span>
              <span className="decode-note">{s.note}</span>
            </li>
          ))}
        </ul>
      </span>
    </span>
  )
}

/**
 * Split a Seagate part number into the things it is actually saying.
 *
 * Derived from the string rather than declared per drive, so a replacement
 * with a different suffix — or a different line entirely — decodes on its own
 * instead of silently showing the old drive's explanation. Anything that is
 * not a Seagate part number returns null and the panel simply does not offer
 * the reading; a decode that guesses is worse than no decode, because the
 * whole point of this is checking a number before spending money on it.
 */
function decodeSeagate(model: string | null): Segment[] | null {
  if (model === null) return null
  const m = /^ST(\d+)([A-Z]{2})(\d+)(?:-(.+))?$/.exec(model)
  if (m === null) return null

  const [, gb, code, variant, suffix] = m
  const cls = SEAGATE_CLASSES[code ?? '']
  const tb = Number(gb) / 1000

  const segments: Segment[] = [
    { key: 'maker', text: 'ST', label: 'Seagate', note: 'The maker. Every Seagate part number opens with it.' },
    {
      key: 'capacity',
      text: gb ?? '',
      label: `${tb % 1 === 0 ? tb.toFixed(0) : tb.toFixed(1)} TB`,
      note: 'Capacity in gigabytes, decimal — which is why the operating system reports less.',
    },
    {
      key: 'class',
      text: code ?? '',
      label: cls?.line ?? 'unknown line',
      note:
        cls?.note ??
        'Seagate’s class code. This one is not in the table on this page, so the line is a guess and is not being made.',
    },
    {
      key: 'variant',
      text: variant ?? '',
      label: 'variant',
      note: 'The generation within that line — platter count, cache and internal design. Two drives differing only here are the same product bought a year apart.',
    },
  ]
  if (suffix !== undefined) {
    segments.push({
      key: 'config',
      text: `-${suffix}`,
      label: 'configuration',
      note: 'Seagate’s internal suffix: firmware, region and how it was packaged. A retail box and a bare OEM drive of the same model differ here and nowhere else.',
    })
  }
  return segments
}

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
        const photo = diskPhoto(disk.model)
        const decoded = decodeSeagate(disk.model)

        return (
          <Board
            key={disk.device}
            title={disk.device}
            icon={nvme ? '⚡' : '▦'}
            /* A third each, so the machine's three drives are one row and one
               reading. At a half they were a pair and an orphan, which put the
               NVMe on a line of its own beside empty grid and read as a second
               subject — and the comparison this page is for is across all
               three: which is hottest, which is oldest, which has the counter
               that moved. Boards stretch to a shared bottom edge, so the row
               is as tall as the drive with the most to say. */
            span={4}
            aside={
              disk.passed === null ? <span className="board-note">no SMART</span>
              : disk.passed ? <Chip tone="ok">SMART ok</Chip>
              : <Chip tone="bad">SMART failing</Chip>
            }
          >
            <div className="disk">
              {photo !== null && (
                <img
                  className={`disk-photo disk-photo-${photo.shape}`}
                  src={photo.src}
                  alt=""
                  width={photo.width}
                  height={photo.height}
                />
              )}
              <div className="disk-id">
                {decoded === null ?
                  <strong className="disk-model">{disk.model ?? '?'}</strong>
                : <ModelDecode model={disk.model ?? '?'} segments={decoded} />}
                <span className="disk-product">
                  {disk.family ?? (nvme ? 'solid state' : 'hard disk')}
                  {disk.sizeBytes !== null && ` · ${bytes(disk.sizeBytes)}`}
                  {disk.rotationRate !== null && disk.rotationRate > 0 &&
                    ` · ${num(disk.rotationRate)} rpm`}
                </span>
                {disk.serial !== null && <span className="disk-serial mono">{disk.serial}</span>}
              </div>
            </div>

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

/* ── Build ────────────────────────────────────────────────────────────── */

type Build = Extract<SystemData, { tab: 'build' }>

/**
 * What each part IS, since no interface on the machine will say.
 *
 * SMBIOS knows the board, the cpu and the memory modules, and that is where
 * this page reads them from. It has never heard of the cooler, the case or
 * the power supply — nothing in a PC reports those — so those three are
 * written down here, and they are the only declared facts on the tab.
 *
 * Written down ONCE, next to the picture, rather than spread through the
 * markup: when one of them is replaced the edit is this table and nothing
 * else, and a part whose photo and specification live in the same object
 * cannot end up showing last year's cooler beside this year's numbers.
 */
type Part = {
  photo: { src: string; width: number; height: number } | null
  name: string
  detail: string
  specs: { k: string; v: string }[]
}

const PARTS = {
  case: {
    photo: { src: '/part-case-jonsbo-n4.png', width: 700, height: 603 },
    name: 'Jonsbo N4',
    detail: 'Steel and wood, six 3.5" bays — the reason this box is a NAS shape and not a tower.',
    specs: [
      { k: 'Bays', v: '6 × 3.5" + 2 × 2.5"' },
      { k: 'Board', v: 'ITX / mATX' },
      { k: 'Size', v: '286 × 300 × 228 mm' },
      { k: 'Cooler clearance', v: '70 mm' },
      { k: 'PSU', v: 'SFX, up to 125 mm' },
    ],
  },
  memory: {
    photo: { src: '/part-ram-vengeance-lpx.png', width: 700, height: 256 },
    name: 'Corsair Vengeance LPX',
    detail:
      'Low-profile heat spreaders, which on a board this small is the specification that matters — a tall kit fouls the cooler.',
    specs: [],
  },
} satisfies Record<string, Part>

function BuildView({ d }: { d: Build }) {
  const hw = d.hardware
  const spinning = d.fans.filter((f) => f.rpm > 0)
  const board = hw.board

  return (
    <BoardGrid>
      <Board
        title="Motherboard"
        icon="⌗"
        span={4}
        aside={
          <span className="board-note">
            {board.bios.version === null ? 'no BIOS reading' : `BIOS ${board.bios.version}`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">{board.model ?? DASH}</strong>
            <span className="part-detail">
              {board.vendor === null ? 'unknown vendor' : shortVendor(board.vendor)}
              {board.version !== null && ` · board rev ${board.version}`}
            </span>
          </div>
        </div>
        <Facts
          rows={[
            { k: 'BIOS', v: <span className="mono">{board.bios.version ?? DASH}</span> },
            { k: 'Built', v: board.bios.date ?? DASH },
            {
              k: 'BIOS vendor',
              v: board.bios.vendor === null ? DASH : shortVendor(board.bios.vendor),
            },
            { k: 'Chipset temp', v: temp(d.temps.find((t) => t.label === 'PCH')?.value ?? null) },
            { k: 'VRM temp', v: temp(d.temps.find((t) => t.label === 'VRM MOS')?.value ?? null) },
          ]}
        />
        <p className="board-foot">
          Read from SMBIOS, so a BIOS update appears here on its own. It is deliberately not
          compared against anything: MSI publishes no machine-readable list of releases, and the
          only way to claim &ldquo;two behind&rdquo; would be to scrape a vendor page that will
          change shape without warning. A version panel that quietly starts lying is worse than
          one that only ever states what is installed.
        </p>
      </Board>

      <Board
        title="Processor"
        icon="◈"
        span={4}
        aside={<span className="board-note">{temp(d.cpu.tempC)}</span>}
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">{cpuName(hw.cpu.model)}</strong>
            <span className="part-detail">
              {hw.cpu.cores === null || hw.cpu.threads === null ?
                'core count unread'
              : `${num(hw.cpu.cores)} cores, ${num(hw.cpu.threads)} threads`}
              {hw.cpu.maxMhz !== null && ` · up to ${(hw.cpu.maxMhz / 1000).toFixed(1)} GHz`}
            </span>
          </div>
        </div>
        <Measures
          items={[
            { k: 'package', v: temp(d.cpu.tempC) },
            { k: 'busy', v: pct(d.cpu.usagePct, 1) },
            {
              k: 'clock',
              v: d.cpu.frequencyMhz === null ? DASH : `${num(Math.round(d.cpu.frequencyMhz))} MHz`,
            },
            { k: 'socket', v: hw.cpu.socket ?? DASH },
          ]}
        />
        <p className="board-foot">
          Ten cores and sixteen threads is not an error: six of them are efficiency cores with no
          hyperthread. That asymmetry is why the per-core temperature list on Host is uneven — the
          two kinds of core do not run at the same clock and are not meant to.
        </p>
      </Board>

      <Board
        title="Cooling"
        icon="❋"
        span={4}
        aside={
          <span className="board-note">
            {spinning.length === 0 ? 'nothing spinning' : `${num(spinning.length)} of ${num(d.fans.length)} headers`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">Noctua NH-L9x65</strong>
            <span className="part-detail">
              65 mm tall, chosen against the case&rsquo;s 70 mm ceiling — the whole build turns on
              this number.
            </span>
          </div>
        </div>
        <h4 className="board-sub">Fan headers</h4>
        <ul className="itemlist">
          {d.fans.map((f) => (
            <li key={f.label}>
              <span className="item-main">{f.label}</span>
              <span className="item-side">
                {f.rpm > 0 ?
                  <span className="mono">{num(f.rpm)} rpm</span>
                : <span className="text-dim">not connected</span>}
              </span>
            </li>
          ))}
          {d.fans.length === 0 && <p className="viz-empty">no fan sensors — see the note below</p>}
        </ul>
        <h4 className="board-sub">Board temperatures</h4>
        <BarList
          items={d.temps.map((t) => ({ label: t.label, value: t.value, display: `${t.value.toFixed(0)}°` }))}
          tone="info"
          empty="no board sensors"
        />
        <p className="board-foot">
          These readings exist because a driver was added for the board&rsquo;s Nuvoton super-I/O
          chip; without it Linux sees three sensors and counts no revolutions at all, which on a
          machine that lives in a cupboard makes a dead fan silent until it is thermal. The headers
          reading zero are not faults — they are empty.
        </p>
      </Board>

      <Board
        title="Memory"
        icon="▤"
        span={4}
        aside={
          <span className="board-note">
            {hw.memory.populated === null || hw.memory.slots === null ?
              DASH
            : `${num(hw.memory.populated)} of ${num(hw.memory.slots)} slots`}
          </span>
        }
      >
        <PartHead part={PARTS.memory} />
        <Facts
          rows={[
            {
              k: 'Installed',
              v: hw.memory.totalGb === null ? DASH : `${num(hw.memory.totalGb)} GB`,
            },
            { k: 'Type', v: hw.memory.modules[0]?.type ?? DASH },
            {
              k: 'Speed',
              v:
                hw.memory.modules[0]?.speedMts == null ?
                  DASH
                : `${num(hw.memory.modules[0].speedMts)} MT/s`,
            },
            {
              k: 'Part',
              v: <span className="mono">{hw.memory.modules[0]?.partNumber ?? DASH}</span>,
            },
            {
              k: 'Room left',
              v:
                hw.memory.maxCapacityGb === null || hw.memory.totalGb === null ?
                  DASH
                : `${num(hw.memory.maxCapacityGb - hw.memory.totalGb)} GB`,
            },
          ]}
        />
        <h4 className="board-sub">Slots</h4>
        <ul className="itemlist">
          {hw.memory.modules.map((m) => (
            <li key={m.locator ?? '?'}>
              <span className="item-main">{(m.locator ?? '?').replace('Controller', 'Ch ')}</span>
              <span className="item-side">{m.sizeGb === null ? DASH : `${num(m.sizeGb)} GB`}</span>
              <span className="item-side">{m.rank === null ? DASH : `${num(m.rank)}R`}</span>
            </li>
          ))}
          {hw.memory.modules.length === 0 && <p className="viz-empty">no modules read</p>}
        </ul>
        <p className="board-foot">
          Both modules sit in the second slot of each channel, which is the pairing the board wants
          for dual channel — the empty slots are the two that would break it if filled wrong. Two
          free slots and a 128 GB ceiling is the upgrade this machine actually has left.
        </p>
      </Board>

      <Board
        title="Graphics"
        icon="◐"
        span={4}
        aside={
          <span className="board-note">
            {d.gpu.clients === null ? DASH : `${num(d.gpu.clients)} clients`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">Intel UHD Graphics 770</strong>
            <span className="part-detail">
              Integrated in the CPU — there is no card in this machine. It transcodes for Jellyfin
              and runs Immich&rsquo;s vision models.
            </span>
          </div>
        </div>
        <Measures
          items={[
            {
              k: 'power',
              v: d.gpu.powerWatts === null ? DASH : `${d.gpu.powerWatts.toFixed(1)} W`,
            },
            {
              k: 'clock',
              v:
                d.gpu.frequencyMhz === null ? DASH : `${num(Math.round(d.gpu.frequencyMhz))} MHz`,
            },
            { k: 'busiest', v: d.gpu.busiestEngine?.name ?? DASH },
            {
              k: 'package',
              v: d.gpu.packageWatts === null ? DASH : `${d.gpu.packageWatts.toFixed(1)} W`,
            },
          ]}
        />
        <p className="board-foot">
          A parked graphics engine reads zero watts and zero megahertz, and that is the honest
          number rather than a broken one — it wakes when something asks it to. The package figure
          beside it is the whole chip including the cpu cores, which is why the two are shown
          together: on an integrated part they are one piece of silicon and one power budget. The
          render node is passed into three containers at once — jellyfin for QSV transcoding,
          immich for OpenVINO, and the exporter these numbers come from.
        </p>
      </Board>

      <Board title="Power" icon="⚡" span={4} aside={<span className="board-note">650 W</span>}>
        <div className="part">
          <div className="part-id">
            <strong className="part-name">EVGA SuperNOVA 650 GM</strong>
            <span className="part-detail">
              SFX, 80+ Gold, fully modular — the form factor the case dictates.
            </span>
          </div>
        </div>
        <h4 className="board-sub">Rails, as the board sees them</h4>
        <ul className="itemlist">
          {['+12V', '+5V', '+3.3V'].map((rail) => {
            const v = d.volts.find((x) => x.label === rail)
            return (
              <li key={rail}>
                <span className="item-main">{rail}</span>
                <span className="item-side mono">
                  {v === undefined ? DASH : `${v.value.toFixed(3)} V`}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="board-foot">
          The supply itself reports nothing — this model has no monitoring interface, so there is
          no temperature, no load and no fan speed to show, and none of those will ever appear
          here. What the board CAN see is what arrives on each rail, which is the next best
          question: a supply beginning to fail sags before it dies.
        </p>
      </Board>

      <Board title="The case" icon="▣" span={12}>
        <div className="part part-wide">
          <PartPhoto part={PARTS.case} />
          <div className="part-id">
            <strong className="part-name">{PARTS.case.name}</strong>
            <span className="part-detail">{PARTS.case.detail}</span>
            <Facts rows={PARTS.case.specs} />
          </div>
        </div>
        <p className="board-foot">
          Six drive bays with two filled, and a 70 mm cooler ceiling that picked the cooler. This
          is the one part on the page that nothing in the machine can report — SMBIOS reports the
          board vendor as the chassis vendor, because a case has no firmware and no way to
          introduce itself, so this panel is written down rather than read.
        </p>
      </Board>

      {/* The snapshot behind the declared-vs-read split: every fact on this
          page that was READ came through this unit or through node-exporter,
          and a stale snapshot shows last week's inventory as though it were
          now. Same neighbour as Disks and Pools, for the same reason. */}
      <LogBoard
        source={{ unit: 'daedalus-system-snapshot.service' }}
        title="System snapshot"
        neighbours={HOST_READERS}
      />
    </BoardGrid>
  )
}

/** A part's photo and name, for the panels that have artwork. */
function PartHead({ part }: { part: Part }) {
  return (
    <div className="part">
      <PartPhoto part={part} />
      <div className="part-id">
        <strong className="part-name">{part.name}</strong>
        <span className="part-detail">{part.detail}</span>
      </div>
    </div>
  )
}

function PartPhoto({ part }: { part: Part }) {
  if (part.photo === null) return null
  return (
    <img
      className="part-photo"
      src={part.photo.src}
      alt=""
      width={part.photo.width}
      height={part.photo.height}
    />
  )
}

/** "Micro-Star International Co., Ltd." is a legal name, not a brand. */
function shortVendor(v: string): string {
  return v
    .replace(/Micro-Star International Co\., Ltd\.?/i, 'MSI')
    .replace(/American Megatrends International, LLC\.?/i, 'AMI')
    .replace(/, (Inc|LLC|Ltd)\.?$/i, '')
}

/** SMBIOS spells it "12th Gen Intel(R) Core(TM) i5-12600K". Nobody says that. */
function cpuName(v: string | null): string {
  return v === null ? DASH : v.replace(/\((R|TM)\)/g, '').replace(/\s+/g, ' ').trim()
}

function temp(c: number | null): string {
  return c === null ? DASH : `${c.toFixed(0)}°`
}

/* ── Database ─────────────────────────────────────────────────────────── */

type Database = Extract<SystemData, { tab: 'database' }>

function DatabaseView({ d }: { d: Database }) {
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
            One cluster, every app a tenant with its own role and database — the consolidation that
            replaced a postgres container per stack. That makes this the single process the most of
            this box depends on, and the reason its minor releases are worth reading: they are
            almost entirely security and data-corruption fixes, and applying one is a restart that
            every tenant feels.
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
            MAJOR is counted — a major upgrade is a pg_upgrade with every tenant offline, which is
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
            note: 'Materialises one role, one database and one env file per fleet.appDatabases entry, generating the password on the box rather than in the store. An app that suddenly cannot connect after being declared is usually this not having run — every tenant is ordered after it, and after podman-pg itself, so a mass restart re-queues them.',
          },
        ]}
      />
      </BoardGrid>
    </>
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
