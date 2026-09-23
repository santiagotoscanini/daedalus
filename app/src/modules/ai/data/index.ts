// The AI module's data half: the chain, as three tabs.
//
// A caller speaks the OpenAI API to LiteLLM; LiteLLM forwards to a model
// server on some machine of this network; that machine holds the weights.
// The page is laid out as that chain — Providers, Gateway, Consumers — and
// each tab is deep about its link: which machines offer what and what is
// loaded; what the gateway routes where and who it answers; what calls it.
//
// ── who answers what ──────────────────────────────────────────────────────
//
//   A provider knows what is on disk and what is resident, and how fast the
//             last generation ran. It does not know who asked.
//   LiteLLM   knows who asked, for what, and what it cost. It has no idea what
//             is loaded — it just forwards.
//   Prometheus holds the history of both; lifetime counters reset with a
//             container, so "over the last N days" is the gateway's ledger or
//             a range query, never a counter read once.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type ConsumersData, loadConsumers } from './consumers'
import { type GatewayData, loadGateway } from './gateway'
import { loadProviders, type ProvidersData } from './providers'

export type Tabs = {
  providers: ProvidersData
  gateway: GatewayData
  consumers: ConsumersData
}
export type AiData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  providers: loadProviders,
  gateway: loadGateway,
  consumers: loadConsumers,
})

export type { Neighbour } from './litellm'
export type { ProviderMachine } from './providers'
