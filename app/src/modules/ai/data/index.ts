// The AI module's data half, one tab per service.
//
// The stack is a chain — a caller speaks the OpenAI API to LiteLLM, LiteLLM
// forwards to Lemonade on the gaming PC, Lemonade holds the weights — and the
// page used to be laid out as that chain, with a diagram across the top and
// every service's numbers crammed into a shared band underneath. That reads
// well exactly once. The questions you come back with are per-service and
// deep: which models are resident and can I free some VRAM, what is the
// gateway actually routing where, is it worth taking the update. None of those
// fit in a quarter of a shared row.
//
// So: a tab per service, and each tab is that service's page. The chain has
// not gone anywhere — it is stated in each tab's one-line lede, which is where
// a fact you already know belongs.
//
// ── who answers what ──────────────────────────────────────────────────────
//
// Worth keeping straight while reading the queries, because these are NOT
// interchangeable and picking the wrong one gives a plausible wrong number:
//
//   Lemonade  knows what is resident, what the GPU is doing, and how fast the
//             last generation ran. It does not know who asked.
//   LiteLLM   knows who asked, for what, and what it cost. It has no idea what
//             is loaded — it just forwards.
//   Prometheus holds the history of both. The lifetime counters each service
//             reports reset when its container restarts, so anything phrased
//             as "over the last N days" comes from the gateway's own ledger or
//             from a range query, never from a counter read once.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type LemonadeData, loadLemonade } from './lemonade'
import { type LitellmData, loadLitellm } from './litellm'
import { loadN8n, type N8nData } from './n8n'
import { loadOpenWebUi, type OpenWebUiData } from './open-webui'

export type Tabs = {
  lemonade: LemonadeData
  litellm: LitellmData
  'open-webui': OpenWebUiData
  n8n: N8nData
}
export type AiData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  lemonade: loadLemonade,
  litellm: loadLitellm,
  'open-webui': loadOpenWebUi,
  n8n: loadN8n,
})

export type { CatalogModel, ModelCategory } from './lemonade'
export type { Neighbour } from './litellm'
