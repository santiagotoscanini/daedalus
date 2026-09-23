import type { Ctx } from '../../../core/ctx'
import { type GatewayRoutes, gatewayRoutes } from '../../../host/providers/gateway'
import { listNodes } from '../../../lib/repo/nodes'
import { type LitellmData, loadLitellm } from './litellm'

// The Gateway tab: LiteLLM's own page (traffic, callers, tools, the
// neighbours) plus its routing table grouped by the machine each route
// forwards to — the routes the sync wrote carry their node; the ones from
// config.yaml are named as such.

export type GatewayData = LitellmData & {
  routing: GatewayRoutes
  /** Node id → the name the pages use, for grouping the routes. */
  machineNames: Record<string, string>
}

export async function loadGateway(ctx: Ctx): Promise<GatewayData> {
  const [litellm, routing, nodes] = await Promise.all([
    loadLitellm(ctx),
    gatewayRoutes(ctx),
    listNodes().catch(() => []),
  ])
  return {
    ...litellm,
    routing,
    machineNames: Object.fromEntries(nodes.map((n) => [n.id, n.name])),
  }
}
