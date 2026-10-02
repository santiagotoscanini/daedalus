import type { Ctx } from '../../core/ctx'
import {
  type LemonadeFacts,
  lemonadeDot,
  type StatusDot,
} from '../../lib/providers/lemonade-status'
import { allNodeRows } from '../../lib/repo/nodes'
import { lemonadeUpdate } from './lemonade-release'
import { STALE_MS } from './read'

// Every approved machine's Lemonade as the dot's facts (lib/providers/
// lemonade-status.ts): the rows, each machine's last providers document from
// the controller's memory, and the release list from the shared GitHub cache —
// nothing here dials a machine or asks GitHub past that cache, so the rail can
// ask every minute.

export async function lemonadeFacts(ctx: Pick<Ctx, 'controller'>, now = Date.now()) {
  const rows = (await allNodeRows()).filter((n) => n.state === 'approved')
  return Promise.all(
    rows.map(async (n): Promise<LemonadeFacts> => {
      const answer = await ctx.controller.call('nodes.providers', { id: n.id }).catch(() => null)
      const r = answer?.providers?.find((p) => p.kind === 'lemonade') ?? null
      const at = answer?.received_at == null ? Number.NaN : Date.parse(answer.received_at)
      const policy = n.policy?.providers?.lemonade
      return {
        name: n.policy?.displayName?.trim() || n.hostname,
        current:
          answer?.connected === true &&
          answer.providers !== null &&
          Number.isFinite(at) &&
          now - at <= STALE_MS,
        report:
          r === null
            ? null
            : {
                running: r.running,
                managed: r.install !== null,
                noUserSession: r.no_user_session,
                manualOff: r.manual_off,
                wanted: r.wanted,
              },
        wanted: policy?.wanted ?? null,
        pinned: policy?.pin !== undefined,
        updateAvailable: r?.version == null ? false : (await lemonadeUpdate(r.version)).behind > 0,
      }
    }),
  )
}

/** The AI row's dot, or null when no machine has Lemonade or is asked to. */
export async function lemonadeStatus(ctx: Pick<Ctx, 'controller'>): Promise<StatusDot | null> {
  return lemonadeDot(await lemonadeFacts(ctx))
}
