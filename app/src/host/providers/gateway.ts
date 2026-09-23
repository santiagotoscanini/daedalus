import type { Ctx } from '../../core/ctx'
import { arrayOf, bool, decode, nullable, obj, optional, str } from '../../lib/contract/decode'
import type { ModelMode, ProviderKind } from '../../lib/providers/kinds'

// The gateway's routing table, as LiteLLM answers `/model/info`: every
// published name, what it forwards to, and — for the routes the sync
// wrote — which node and provider it came from. Read with the master key
// the box holds; the page groups routes by machine with this, and the sync
// reconciles against it.

export type GatewayRoute = {
  /** LiteLLM's id for the row. */
  id: string | null
  /** In the gateway's database (written through its API) rather than in config.yaml. */
  inDb: boolean
  /** The published name callers use. */
  alias: string
  /** `openai/<id>` — the transport and the upstream id. */
  upstream: string
  /** Host and port the route dials, or null when the route has no api_base. */
  host: string | null
  mode: ModelMode | string | null
  /** Set by the sync; a route without it is hand-written. */
  daedalus: { node: string; kind: ProviderKind | string; id: string } | null
}

const routeDecoder = obj({
  model_name: str,
  litellm_params: obj({
    model: optional(str, ''),
    api_base: optional(nullable(str), null),
  }),
  model_info: optional(
    obj({
      id: optional(nullable(str), null),
      mode: optional(nullable(str), null),
      db_model: optional(bool, false),
      daedalus: optional(nullable(obj({ node: str, kind: str, id: str })), null),
    }),
    { id: null, mode: null, db_model: false, daedalus: null },
  ),
})

const infoDecoder = obj({ data: arrayOf(routeDecoder) })

function hostOf(base: string | null): string | null {
  if (base === null) return null
  try {
    const u = new URL(base)
    return u.port === '' ? u.hostname : `${u.hostname}:${u.port}`
  } catch {
    return base
  }
}

export type GatewayRoutes = {
  configured: boolean
  routes: GatewayRoute[]
  error: string | null
}

/** Every route the gateway serves; empty with `configured: false` on a box without one. */
export async function gatewayRoutes(ctx: Ctx): Promise<GatewayRoutes> {
  const g = ctx.gateway
  if (g === null) return { configured: false, routes: [], error: null }
  const body = await ctx.http.getJson<unknown>(`${g.baseUrl}/model/info`, {
    headers: { Authorization: `Bearer ${g.apiKey}` },
  })
  if (body === null)
    return { configured: true, routes: [], error: 'the gateway did not answer /model/info' }
  try {
    const doc = decode(infoDecoder, body)
    return {
      configured: true,
      error: null,
      routes: doc.data.map((r) => ({
        id: r.model_info.id,
        inDb: r.model_info.db_model,
        alias: r.model_name,
        upstream: r.litellm_params.model,
        host: hostOf(r.litellm_params.api_base),
        mode: r.model_info.mode,
        daedalus: r.model_info.daedalus,
      })),
    }
  } catch (e) {
    return {
      configured: true,
      routes: [],
      error: e instanceof Error ? e.message : 'unreadable /model/info',
    }
  }
}
