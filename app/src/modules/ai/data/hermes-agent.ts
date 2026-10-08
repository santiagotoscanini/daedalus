import type { Ctx } from '../../../core/ctx'
import { imagePins } from '../../../host/contract/domains/images'
import { type MonitoredJob, monitoredJobsList } from '../../../host/contract/domains/jobs'
import { declaredSsoClients } from '../../../host/contract/domains/sso'
import { type AppResources, containerResources } from '../../../lib/apps/metrics'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { hostFacts } from '../../../lib/dashboard/host-facts'
import {
  type ImageFreshness,
  imageFreshness,
  imageVersion,
  type RunningVersion,
} from '../../../lib/dashboard/images'
import { getJson } from '../../../lib/http'
import { releases } from '../releases'
import { type LitellmData, loadLitellm } from './litellm'

// The Hermes Agent tab: one agent container, read from every side the box
// already measures. Nothing here talks to the agent itself — it has no
// dashboard API worth reading and its own page is one click away — so every
// board is a join of things published elsewhere: gatus, the container
// exporter, Loki, the gateway's ledger and key table, the images and jobs
// exports, and GitHub's release list.

/** The id every export, probe, log stream and gateway key alias of this stack shares. */
const ID = 'hermes-agent'

/** What the gateway's key table says this caller may reach. Never the key itself. */
type KeyPolicy = {
  /** Model names the key is limited to. Empty means the key is not restricted. */
  models: string[]
  /** MCP servers the key is granted. */
  mcpServers: string[]
  rpmLimit: number | null
  tpmLimit: number | null
  maxBudget: number | null
  /** Seconds since the gateway last saw the key used. */
  lastActiveAgo: number | null
}

type GatewayKey = {
  models?: string[]
  rpm_limit?: number | null
  tpm_limit?: number | null
  max_budget?: number | null
  last_active?: string | null
  object_permission?: { mcp_servers?: string[] } | null
}

export type HermesAgentData = {
  /** `https://<hostname>` from the publishing export; null when it publishes none. */
  url: string | null
  version: string | null
  running: RunningVersion
  gap: VersionGap
  freshness: ImageFreshness | null
  /** The digest pin, from the images export. Null for a container with no digest pin. */
  pin: { image: string; tag: string; digest: string; updatable: boolean } | null
  /** container_up. Null when Prometheus does not know the container. */
  containerUp: boolean | null
  /** gatus' last answer for the probe of this name. */
  healthy: boolean | null
  resources: AppResources
  gateway: {
    configured: boolean
    /** The days the ledger window spans. */
    days: number
    /** This caller's row in the ledger; null when its key made no request in the window. */
    caller: LitellmData['callers'][number] | null
    key: KeyPolicy | null
  }
  /** The OIDC client the box declares for it, from the sso export. */
  sso: { id: string; displayName: string } | null
  /** The scheduled checks the box registers for it, with the host's last run of each. */
  jobs: {
    unit: string
    email: boolean
    slug: string | null
    lastRunAgo: number | null
    result: string | null
    exitStatus: number | null
    nextIn: number | null
  }[]
}

export async function loadHermesAgent(ctx: Ctx): Promise<HermesAgentData> {
  const [running, freshness, pins, up, gatus, resources, litellm, key, sso, registry, facts, web] =
    await Promise.all([
      imageVersion(ID),
      imageFreshness(ID),
      imagePins(),
      ctx.prom.scalar(`container_up{name="${ctx.prom.escape(ID)}"}`),
      ctx.prom.vector(
        `max_over_time(gatus_results_endpoint_success{name="${ctx.prom.escape(ID)}"}[3m])`,
      ),
      containerResources(ctx, ID),
      ctx.gateway === null ? Promise.resolve(null) : loadLitellm(ctx),
      keyPolicy(ctx),
      declaredSsoClients(),
      monitoredJobsList(),
      hostFacts(),
      publishedUrl(ctx),
    ])

  // The image tag is the calendar one (`v2026.9.24`); the newest release is
  // tagged `v0.21.6` and carries no calendar part, so ordering is by the engine
  // number in the release names (`byName`, see GapOptions).
  const gap = await versionGap('NousResearch/hermes-agent', running.version, {
    ...releases['hermes-agent']?.opts,
  })

  const pin = pins[ID]
  const mine = registry.filter((j: MonitoredJob) => j.unit.startsWith(ID))
  const now = Date.now() / 1000
  const runs = new Map(
    facts.jobs.flatMap((r) => [
      [r.timer.replace(/\.timer$/, ''), r] as const,
      ...(r.service === null ? [] : ([[r.service.replace(/\.service$/, ''), r]] as const)),
    ]),
  )

  return {
    url: web,
    version: running.version,
    running,
    gap,
    freshness,
    pin:
      pin === undefined
        ? null
        : { image: pin.image, tag: pin.tag, digest: pin.digest, updatable: pin.updatable },
    containerUp: up === null ? null : up >= 1,
    healthy: gatus[0] === undefined ? null : gatus[0].value[1] === '1',
    resources,
    gateway: {
      configured: litellm?.configured === true,
      days: litellm?.window.days ?? 0,
      caller: litellm?.callers.find((c) => c.name === ID) ?? null,
      key,
    },
    sso: sso.clients.find((c) => c.id === ID) ?? null,
    jobs: mine.map((j) => {
      const run = runs.get(j.unit)
      const lastAt = run?.lastAt ?? null
      return {
        unit: j.unit,
        email: j.email,
        slug: j.slug,
        lastRunAgo: lastAt === null ? null : now - lastAt,
        result: lastAt === null ? null : (run?.result ?? null),
        exitStatus: lastAt === null ? null : (run?.exitStatus ?? null),
        nextIn: run?.nextAt == null ? null : run.nextAt - now,
      }
    }),
  }
}

async function publishedUrl(ctx: Ctx): Promise<string | null> {
  const { publishingFacts } = await import('../../../host/contract/domains/publishing')
  const app = (await publishingFacts()).webApps[ID]
  return app === undefined ? null : ctx.hosts.base(ID)
}

/**
 * The key's policy, from the gateway's own key table.
 *
 * Filtered by alias on the server (`key_alias`), so this reads one row and the
 * token never leaves the gateway's answer: only the fields above are kept.
 * Null when the gateway is unbound, refuses, or holds no key of that alias.
 */
async function keyPolicy(ctx: Ctx): Promise<KeyPolicy | null> {
  const gateway = ctx.gateway
  if (gateway === null) return null
  const body = await getJson<{ keys?: GatewayKey[] }>(
    `${gateway.baseUrl}/key/list?return_full_object=true&size=1&key_alias=${encodeURIComponent(ID)}`,
    { headers: { Authorization: `Bearer ${gateway.apiKey}` } },
  )
  const k = body?.keys?.[0]
  if (k === undefined) return null
  return {
    models: k.models ?? [],
    mcpServers: k.object_permission?.mcp_servers ?? [],
    rpmLimit: k.rpm_limit ?? null,
    tpmLimit: k.tpm_limit ?? null,
    maxBudget: k.max_budget ?? null,
    lastActiveAgo:
      k.last_active == null || Number.isNaN(Date.parse(k.last_active))
        ? null
        : (Date.now() - Date.parse(k.last_active)) / 1000,
  }
}
