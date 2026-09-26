import type { Ctx } from '../../core/ctx'
import { decode } from '../../lib/contract/decode'
import {
  lemonadeCatalogDecoder,
  lemonadeHealthDecoder,
  type ProviderHealth,
  type ProviderKind,
  type ProviderModel,
  SUBGEN_MODEL,
} from '../../lib/providers/kinds'

// Reading a provider: the catalog and the health, from the provider's own
// API at the address the gateway dials. Server-only (it reads the network
// through the Ctx); the pure decoders are in lib/providers/kinds.ts.
//
// Remembered for a minute per address: the AI page asks on every visit,
// the gateway sync (host/gateway-sync.ts) after every node hello and every
// five minutes, and a catalog does not move between them. A provider that does not answer is `reachable:
// false` with the last catalog it gave, so a machine asleep keeps its
// rows on the page and loses its routes in the gateway — the two readers
// decide that for themselves.

export type ProviderReading = {
  kind: ProviderKind
  base: string
  reachable: boolean
  health: ProviderHealth
  models: ProviderModel[]
  /** Why it is unreachable, in a sentence, or null. */
  error: string | null
  readAt: number
}

const TTL_MS = 60_000
const memory = new Map<string, ProviderReading>()

export function forgetProviders(): void {
  memory.clear()
}

const unreachable = (
  kind: ProviderKind,
  base: string,
  error: string,
  now: number,
): ProviderReading => ({
  kind,
  base,
  reachable: false,
  health: { ok: false, version: null, loaded: [] },
  models: memory.get(`${kind} ${base}`)?.models ?? [],
  error,
  readAt: now,
})

export async function readProvider(
  ctx: Ctx,
  kind: ProviderKind,
  base: string,
  now: number = Date.now(),
): Promise<ProviderReading> {
  const key = `${kind} ${base}`
  const hit = memory.get(key)
  if (hit !== undefined && now - hit.readAt < TTL_MS) return hit

  const root = base.replace(/\/+$/, '')
  const get = (path: string) => ctx.http.getJson<unknown>(`${root}${path}`)
  let reading: ProviderReading
  try {
    switch (kind) {
      case 'lemonade': {
        const [health, catalog] = await Promise.all([get('/api/v1/health'), get('/api/v1/models')])
        if (health === null) {
          reading = unreachable(kind, base, 'did not answer /api/v1/health', now)
          break
        }
        reading = {
          kind,
          base,
          reachable: true,
          health: decode(lemonadeHealthDecoder, health),
          models: catalog === null ? [] : decode(lemonadeCatalogDecoder, catalog),
          error: null,
          readAt: now,
        }
        break
      }
      case 'subgen': {
        const status = await get('/status')
        reading =
          status === null
            ? unreachable(kind, base, 'did not answer /status', now)
            : {
                kind,
                base,
                reachable: true,
                health: {
                  ok: true,
                  version: null,
                  loaded: [{ id: SUBGEN_MODEL.id, device: null, maxContext: null, pinned: true }],
                },
                models: [SUBGEN_MODEL],
                error: null,
                readAt: now,
              }
        break
      }
    }
  } catch (e) {
    reading = unreachable(kind, base, e instanceof Error ? e.message : 'unreadable answer', now)
  }
  memory.set(key, reading)
  return reading
}
