import type { Ctx } from '../core/ctx'
import { activeModules } from '../lib/modules/active'
import { MODULES } from '../lib/modules/registry'
import type { RailBadge, RailBadges } from '../lib/rail-badge'
import type { Tone } from '../lib/tone'
import { tabStatuses } from './tab-status'

// The rail's dots, by module id: what a module wants to say about itself on
// every page, before anyone opens it. Cheap by contract — readings the box
// already holds — because the shell asks every minute. A producer that throws
// draws no dot rather than breaking the rail.
//
// Two sources, and the worse one wins:
//   - the roll-up of the module's own tab dots (host/tab-status.ts): green
//     only when EVERY tab that is probed answers; red naming the ones that do
//     not. A module none of whose tabs is probed says nothing.
//   - a module's own producer, for a verdict the tab dots cannot express.

const PRODUCERS: Record<string, (ctx: Ctx) => Promise<RailBadge | null>> = {
  // Lemonade on the machines that offer models (AI › Providers).
  ai: async (ctx) => {
    const { lemonadeStatus } = await import('./providers/status')
    const dot = await lemonadeStatus(ctx)
    if (dot === null) return null
    return {
      tone: dot.tone,
      label:
        dot.reasons.length === 0
          ? 'Lemonade runs wherever it is wanted'
          : `Lemonade: ${dot.reasons.join('; ')}`,
    }
  },
}

const RANK: Partial<Record<Tone, number>> = { bad: 3, warn: 2, ok: 1 }
const rank = (b: RailBadge) => RANK[b.tone] ?? 0

/** The worse of two verdicts; both sentences when neither is clean. */
function worse(a: RailBadge | null, b: RailBadge | null): RailBadge | null {
  if (a === null || b === null) return a ?? b
  const [hi, lo] = rank(a) >= rank(b) ? [a, b] : [b, a]
  return lo.tone === 'ok' ? hi : { tone: hi.tone, label: `${hi.label} · ${lo.label}` }
}

async function rollUps(ctx: Ctx): Promise<Record<string, RailBadge>> {
  const active = activeModules(MODULES, ctx.modules.state)
  const statuses = await tabStatuses(ctx.prom, active)
  const out: Record<string, RailBadge> = {}
  for (const m of active) {
    const status = statuses[m.id] ?? {}
    const known = m.tabs.filter((t) => t.off !== true && typeof status[t.id] === 'boolean')
    if (known.length === 0) continue
    const down = known.filter((t) => status[t.id] === false)
    out[m.id] =
      down.length === 0
        ? {
            tone: 'ok',
            label: known.length === 1 ? 'Answering' : `All ${String(known.length)} answering`,
          }
        : { tone: 'bad', label: `Not answering: ${down.map((t) => t.label).join(', ')}` }
  }
  return out
}

export async function railBadges(ctx: Ctx): Promise<RailBadges> {
  const [rolled, produced] = await Promise.all([
    rollUps(ctx).catch(() => ({}) as Record<string, RailBadge>),
    Promise.all(
      Object.entries(PRODUCERS).map(
        async ([id, produce]) => [id, await produce(ctx).catch(() => null)] as const,
      ),
    ),
  ])
  const out: RailBadges = { ...rolled }
  for (const [id, badge] of produced) {
    const merged = worse(rolled[id] ?? null, badge)
    if (merged !== null) out[id] = merged
  }
  return out
}
