import type { Ctx } from '../core/ctx'
import type { RailBadge, RailBadges } from '../lib/rail-badge'

// The rail's dots, by module id: what a module wants to say about itself on
// every page, before anyone opens it. One producer per module that has
// something to say; each is cheap by contract — readings the box already
// holds and caches it already keeps — because the shell asks every minute.
// A producer that throws draws no dot rather than breaking the rail.

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

export async function railBadges(ctx: Ctx): Promise<RailBadges> {
  const entries = await Promise.all(
    Object.entries(PRODUCERS).map(async ([id, produce]) => {
      const badge = await produce(ctx).catch(() => null)
      return badge === null ? [] : [[id, badge] as const]
    }),
  )
  return Object.fromEntries(entries.flat())
}
