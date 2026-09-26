import type { NodeDrive, NodeTelemetry } from '../../lib/agent/status'
import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, pct } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { MONO_FACE } from '../tokens'
import { Board, BoardGrid, Chip, Facts, Measures, Progress } from '../viz'
import {
  DetailNote,
  EMPTY,
  FOOT,
  hours,
  LIST,
  loadTone,
  MONO,
  NOTE,
  NotReadable,
  ofTotal,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
  share,
} from './shared'

/* ── Disks ────────────────────────────────────────────────────────────── */

/** What SMART calls the drive — the string you would type into a shop. */
const DISK_MODEL = 'text-[0.94rem] text-foreground tracking-[-0.01em] wrap-anywhere'

function healthChip(h: string | null): { tone: Tone; label: string } {
  switch (h) {
    case 'healthy':
    case 'verified':
      return { tone: 'ok', label: 'SMART ok' }
    case 'warning':
      return { tone: 'warn', label: 'SMART warning' }
    case 'unhealthy':
    case 'failing':
      return { tone: 'bad', label: 'SMART failing' }
    case 'not supported':
      return { tone: 'muted', label: 'no SMART' }
    default:
      return { tone: 'muted', label: 'health unread' }
  }
}

/** The volumes on a drive, matched by the mounts the agent listed on it. */
function volumesOf(drive: NodeDrive, t: NodeTelemetry) {
  return t.disks.filter((v) => drive.volumes.includes(v.mount))
}

function VolumeRows({ volumes }: { volumes: NodeTelemetry['disks'] }) {
  return (
    <ul className={LIST}>
      {volumes.map((v) => {
        const p = share(v.usedBytes, v.totalBytes)
        return (
          <li key={v.mount} className={`${ROW} flex-wrap`}>
            <span className={cn(ROW_MAIN, 'flex items-baseline gap-2')}>
              <span className={cn(MONO, 'font-medium')}>{v.mount}</span>
              <span className={NOTE}>{[v.name, v.fs].filter(Boolean).join(' · ')}</span>
            </span>
            <span className={`${ROW_SIDE} flex items-center gap-3`}>
              <span className="w-20 flex-none">
                <Progress pct={p} tone={loadTone(p)} />
              </span>
              <span className="tabular-nums">
                {ofTotal(v.usedBytes, v.totalBytes)}
                {p !== null && ` · ${pct(p)}`}
              </span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The box's Disks tab, for a node: one board per physical drive, the
 * volumes on it underneath, and the same "what would fail first" counters
 * where the OS hands them over.
 *
 * Windows does, through its storage reliability counters, which is most of
 * what smartctl would say. macOS hands over one word — SMART "verified" or
 * not — and nothing else without smartmontools, and the board says so
 * rather than drawing dashes the reader has to interpret.
 */
export function NodeDisksView({ d }: { d: NodeSystemData }) {
  const { node } = d
  const t = d.telemetry
  if (t === null) return null
  const onDrives = new Set(t.drives.flatMap((x) => x.volumes))
  const loose = t.disks.filter((v) => !onDrives.has(v.mount))

  return (
    <BoardGrid>
      {t.drives.map((drive, i) => {
        const h = healthChip(drive.health)
        const vols = volumesOf(drive, t)
        const ssd = drive.kind === 'ssd' || drive.bus === 'nvme'
        return (
          <Board
            key={`${drive.name}-${String(i)}`}
            title={drive.bus === null ? `Drive ${String(i + 1)}` : drive.bus.toUpperCase()}
            icon={drive.bus === 'nvme' ? '⚡' : '▦'}
            span={4}
            aside={<Chip tone={h.tone}>{h.label}</Chip>}
          >
            <div className="flex min-w-0 flex-col items-start gap-[0.22rem] pb-2">
              <strong className={DISK_MODEL}>{drive.name || '?'}</strong>
              <span className="text-[0.72rem] text-(--text-muted) leading-[1.3]">
                {drive.kind === null
                  ? ssd
                    ? 'solid state'
                    : 'drive'
                  : drive.kind === 'ssd'
                    ? 'solid state'
                    : 'hard disk'}
                {drive.sizeBytes !== null && ` · ${bytes(drive.sizeBytes)}`}
                {drive.removable === true && ' · removable'}
                {drive.firmware !== null && ` · fw ${drive.firmware}`}
              </span>
              {/* The one line here that is never read and always needed: it is
                  what an RMA asks for. Only the full document carries it. */}
              {drive.serial !== null && (
                <span className={cn(MONO_FACE, 'text-[0.7rem] text-muted-foreground')}>
                  {drive.serial}
                </span>
              )}
            </div>

            <Measures
              items={[
                {
                  k: 'temperature',
                  v: drive.temperatureC === null ? DASH : `${drive.temperatureC.toFixed(0)}°`,
                },
                { k: 'powered on', v: hours(drive.powerOnHours) },
                {
                  k: ssd ? 'endurance used' : 'wear',
                  v: pct(drive.wearPct),
                },
              ]}
            />

            <h4 className={SUB}>What would fail first</h4>
            <Facts
              rows={[
                { k: 'Read errors', v: num(drive.readErrors) },
                { k: 'Write errors', v: num(drive.writeErrors) },
                {
                  k: 'Verdict',
                  v: drive.health === null ? DASH : drive.health,
                },
              ]}
            />

            {vols.length > 0 && (
              <>
                <h4 className={SUB}>Volumes on it</h4>
                <VolumeRows volumes={vols} />
              </>
            )}
          </Board>
        )
      })}

      {(loose.length > 0 || t.drives.length === 0) && (
        <Board
          title={t.drives.length === 0 ? 'Volumes' : 'Other volumes'}
          icon="▦"
          span={12}
          aside={<span className={NOTE}>{num(loose.length)} mounted</span>}
        >
          {loose.length === 0 ? (
            <p className={EMPTY}>No volumes reported.</p>
          ) : (
            <VolumeRows volumes={loose} />
          )}
          <DetailNote d={d} />
          <p className={FOOT}>
            {t.drives.length === 0
              ? 'What the OS mounts, without the drives behind them: the agent reads the physical drives every ten minutes and has reported none.'
              : 'Mounted volumes the agent could not place on a drive above — network shares, disk images, and anything the OS mounts without a physical device.'}
          </p>
        </Board>
      )}

      <Board title="How these are checked" icon="✓" span={12}>
        <Facts
          rows={
            node.os === 'windows'
              ? [
                  { k: 'Health', v: 'Windows’ own storage health, every ten minutes' },
                  {
                    k: 'Counters',
                    v: 'the storage reliability counters: temperature, hours, wear, errors',
                  },
                  {
                    k: 'Self-tests',
                    v: 'none scheduled — Windows runs no SMART self-tests on its own',
                  },
                ]
              : [
                  { k: 'Health', v: 'SMART’s one-word verdict, every ten minutes' },
                  { k: 'Counters', v: 'not readable: macOS ships no SMART reader' },
                  { k: 'Self-tests', v: 'none — Apple’s firmware runs its own, unannounced' },
                ]
          }
        />
        <p className={FOOT}>
          {node.os === 'windows'
            ? 'The same attributes smartctl would read, handed over by the storage stack, so the temperature here is at most ten minutes old. A drive the OS marks warning has crossed a threshold the drive itself set. Unlike the box, nothing here runs a self-test on a schedule; the counters are what the drive accumulates on its own.'
            : 'Apple exposes whether SMART is verified and nothing behind it. Temperature, hours and wear would need smartmontools installed on the machine, which the agent does not do; if that is ever wanted, it is a policy switch on Settings › Machines, not a change here.'}
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}
