import { Link } from '@tanstack/react-router'

import type { NodeApp, NodeTelemetry } from '../../lib/agent/status'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, pct } from '../../lib/format'
import { partMatching } from '../../lib/hardware/catalog'
import { PartPhoto } from '../part'
import { Board, BoardGrid, Chip, Facts, Measures } from '../viz'
import {
  ago,
  DetailNote,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  WipBoard,
} from './shared'

/* ── Graphics ─────────────────────────────────────────────────────────── */

/**
 * The Windows PC's Graphics tab: the card, its driver, and what games ask
 * of the system around it.
 *
 * On a gaming PC the graphics driver is the one piece of software whose
 * version a person actually tracks — a game's launch-day patch is as often
 * a driver as a game. Windows reports the driver twice: the WDDM number
 * the registry files it under (32.0.31041.1004) and the name the vendor
 * sells it by (Adrenalin 25.9.2, GeForce 566.14), and the second is the
 * one that means anything. Beside the driver sit the runtimes a game
 * loads — the Visual C++ and .NET redistributables, DirectX, Vulkan —
 * which are "the DLLs" in the sense that matters: what a game's installer
 * puts on the machine so the game can start.
 */
export function NodeGraphicsView({ d }: { d: NodeSystemData }) {
  const t = d.telemetry
  if (t === null) return null
  // The discrete card first; an APU's own graphics is a footnote beside it.
  const gpus = [...t.gpus].sort((a, b) => (b.vramTotalBytes ?? 0) - (a.vramTotalBytes ?? 0))
  const main = gpus[0] ?? null
  const second = gpus[1] ?? null
  // Battle.net is not a .NET; the Software tab makes the same correction.
  const runtimes = t.apps.filter((a) => a.kind === 'runtime' && !/^Battle\.net$/i.test(a.name))

  return (
    <BoardGrid>
      {main === null ? (
        <Board title="No graphics adapter" icon="▦" span={8}>
          <p className={EMPTY}>
            {t.errors.find((e) => /display adapter/i.test(e)) ??
              'The agent found no display adapter in the registry.'}
          </p>
        </Board>
      ) : (
        <GpuBoard g={main} span={8} main />
      )}
      {second !== null ? (
        <GpuBoard g={second} span={4} main={false} />
      ) : (
        <Board title="One adapter" icon="▦" span={4}>
          <p className={EMPTY}>No second graphics adapter: the processor has none, or it is off.</p>
        </Board>
      )}

      {/* AMD's and NVIDIA's download pages sit behind the same bot wall as
          Gigabyte's, and neither publishes a feed. The box's browser job
          already reads Gigabyte for the Motherboard tab; the driver page
          is the same shape of work, not yet done. */}
      <WipBoard
        title="Vendor ships"
        icon="⇣"
        span={6}
        waits={
          main?.vendor === 'AMD'
            ? 'AMD’s driver page refuses plain clients, as Gigabyte’s does; the box’s browser job can read it next, and then this says how far behind the Adrenalin package is.'
            : 'The vendor’s driver page refuses plain clients; the box’s browser job can read it next, and then this says how far behind the driver is.'
        }
      >
        <Measures
          items={[
            { k: 'newest', v: main?.vendor === 'AMD' ? 'Adrenalin 26.9.1' : '581.42' },
            { k: 'published', v: '3 days ago' },
            { k: 'behind', v: '2' },
          ]}
        />
        <p className={FOOT}>
          The vendor&rsquo;s current WHQL package, read from its download page daily. A driver two
          behind is a month of game-day fixes not applied.
        </p>
      </WipBoard>

      {/* Windows counts VRAM and busy through its performance counters and
          nothing more; die temperature, clocks, power and fan need the
          vendor's SDK (ADLX, NVML) or a kernel driver. */}
      <WipBoard
        title="Live"
        icon="◉"
        span={6}
        waits="Temperature, hotspot, clocks, power and fan need AMD’s ADLX or NVIDIA’s NVML; the agent reads only what Windows itself counts — VRAM and busy — until it carries one."
      >
        <Measures
          items={[
            { k: 'die', v: '61°' },
            { k: 'hotspot', v: '78°' },
            { k: 'core', v: '2 480 MHz' },
            { k: 'power', v: '212 W' },
            { k: 'fan', v: '1 350 rpm' },
          ]}
        />
      </WipBoard>

      <Board
        title={runtimes.length === 0 ? 'Runtimes' : `${num(runtimes.length)} runtimes`}
        icon="⧉"
        span={12}
        aside={<span className={NOTE}>what games load</span>}
      >
        {t.appCount === null ? (
          <p className={EMPTY}>
            {d.full
              ? 'The software inventory arrives with agent 0.10.0; the agent installs it on its own within ten minutes of the release.'
              : 'On the full document.'}
          </p>
        ) : runtimes.length === 0 ? (
          <p className={EMPTY}>No redistributable runtime is registered on this machine.</p>
        ) : (
          <ul className={LIST}>
            {[...runtimes].sort(byFamily).map((a) => (
              <li key={`${a.name}-${a.version ?? ''}`} className={ROW}>
                <span className={ROW_MAIN}>{a.name}</span>
                <span className={ROW_SIDE}>
                  {a.version !== null && <span className={MONO}>{a.version}</span>}
                  {a.installedAt !== null && ` · ${ago(a.installedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DetailNote d={d} />
        <p className={FOOT}>
          Visual C++ and .NET redistributables, Vulkan, OpenAL, PhysX: what a game&rsquo;s installer
          puts on the machine so the game can find its libraries. Several versions of the same one
          side by side is normal — each game pins the one it was built against — and DirectX 12 is
          part of Windows 11 itself, not a package. The whole inventory is on{' '}
          <Link
            to="/c/$category"
            params={{ category: 'system' }}
            search={{ tab: 'software', machine: d.node.id }}
          >
            Software
          </Link>
          .
        </p>
      </Board>
    </BoardGrid>
  )
}

function GpuBoard({
  g,
  span,
  main,
}: {
  g: NodeTelemetry['gpus'][number]
  span: 4 | 8
  main: boolean
}) {
  const part = partMatching('gpu', g.name)
  const used =
    g.vramUsedBytes !== null && g.vramTotalBytes !== null
      ? (g.vramUsedBytes / g.vramTotalBytes) * 100
      : null
  return (
    <Board
      title={main ? 'The card' : 'Also'}
      icon="▦"
      span={span}
      aside={
        g.driverBrand !== null ? (
          <Chip tone="info">{g.driverBrand}</Chip>
        ) : (
          <span className={NOTE}>{g.vendor ?? DASH}</span>
        )
      }
    >
      <div className={PART}>
        {part !== null && main && <PartPhoto part={part} />}
        <div className={PART_ID}>
          <strong className={PART_NAME}>{cleanGpu(g.name)}</strong>
          <span className={PART_DETAIL}>
            {g.vendor ?? 'vendor unread'}
            {g.vramTotalBytes !== null && ` · ${bytes(g.vramTotalBytes)} VRAM`}
            {!main && ' · on the processor'}
          </span>
        </div>
      </div>
      {main && (
        <Measures
          items={[
            { k: 'busy', v: pct(g.usagePct, 0) },
            { k: 'vram used', v: g.vramUsedBytes === null ? DASH : bytes(g.vramUsedBytes) },
            { k: 'of', v: g.vramTotalBytes === null ? DASH : bytes(g.vramTotalBytes) },
            { k: 'share', v: pct(used, 0) },
          ]}
        />
      )}
      <Facts
        rows={[
          {
            k: 'Driver',
            v: g.driverBrand === null ? DASH : g.driverBrand,
          },
          {
            k: 'Windows calls it',
            v: g.driver === null ? DASH : <span className={MONO}>{g.driver}</span>,
          },
          { k: 'Built', v: g.driverDate === null ? DASH : ago(g.driverDate) },
        ]}
      />
      <p className={FOOT}>
        {main
          ? 'Busy and VRAM are Windows’ own counters, sampled every fifteen seconds. The driver’s vendor name is what the download page and the game patch notes mean by a version; the WDDM number is how Windows files it.'
          : 'The processor’s own graphics, which Windows keeps a driver for even when nothing is plugged into it.'}
        {g.driverBrand === null &&
          g.driver !== null &&
          ' The vendor name arrives with agent 0.10.0.'}
      </p>
    </Board>
  )
}

/** "AMD Radeon(TM) Graphics" → "AMD Radeon Graphics". */
function cleanGpu(name: string): string {
  return name
    .replace(/\((R|TM)\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Visual C++ together, newest first; then .NET; then the rest by name. */
function byFamily(a: NodeApp, b: NodeApp): number {
  const fam = (x: NodeApp) =>
    /visual c\+\+/i.test(x.name)
      ? 0
      : /\.net/i.test(x.name)
        ? 1
        : /directx|vulkan/i.test(x.name)
          ? 2
          : 3
  const fa = fam(a)
  const fb = fam(b)
  if (fa !== fb) return fa - fb
  return a.name.localeCompare(b.name, undefined, { numeric: true }) * (fa === 0 ? -1 : 1)
}
