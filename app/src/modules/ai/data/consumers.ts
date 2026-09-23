import type { Ctx } from '../../../core/ctx'
import { listApps } from '../../../lib/repo/apps'
import { loadN8n, type N8nData } from './n8n'
import { loadOpenWebUi, type OpenWebUiData } from './open-webui'

// The Consumers tab: what calls the gateway. Open WebUI and n8n keep the
// pages they had, one under the other; the apps that hold a gateway key
// are a list, since their pages are their own.

export type ConsumersData = {
  openWebui: OpenWebUiData | null
  n8n: N8nData | null
  apps: { name: string }[]
}

export async function loadConsumers(ctx: Ctx): Promise<ConsumersData> {
  const [openWebui, n8n, apps] = await Promise.all([
    ctx.modules.enabled('open-webui') ? loadOpenWebUi(ctx) : Promise.resolve(null),
    ctx.modules.enabled('n8n') ? loadN8n(ctx) : Promise.resolve(null),
    listApps().catch(() => []),
  ])
  return { openWebui, n8n, apps: apps.filter((a) => a.litellm).map((a) => ({ name: a.name })) }
}
