import { readApplyStatus } from '../../lib/apply'
import { networkSnapshot } from '../../lib/contract/domains/network'
import { repoFacts } from '../../lib/contract/domains/repo'
import { siteIdentity } from '../../lib/contract/domains/site'
import type { SnapshotResult } from '../../lib/contract/snapshot'
import { manifestEntries } from '../../lib/nix-manifest'
import type { Ctx } from '../ctx'
import type { BoxSettings, SourceMeta } from './types'

// The reader behind Settings: what this box IS, assembled from the three
// places a fact can already reach the container — env bound by daedalus.nix,
// the /export domains, and the host snapshots. Nothing here is editable and
// nothing here is guessed: a value the box has not stated renders as absent,
// which is the honest reading of "not configured".
//
// The site repository (plan, Phase 3) becomes the fourth source and, for
// everything nix consumes, the first. This reader is where that swap happens,
// one section at a time, without the page noticing.

const meta = (r: SnapshotResult<unknown>): SourceMeta => ({
  available: r.available,
  stale: r.stale,
  generatedAt: r.generatedAt,
  error: r.error,
})

export async function readBoxSettings(ctx: Ctx): Promise<BoxSettings> {
  const [site, network, repo, applyStatus, entries] = await Promise.all([
    siteIdentity(),
    networkSnapshot(),
    repoFacts(),
    readApplyStatus(),
    // The manifest is the one source that says how THIS app is run; an
    // unreadable manifest costs the dev-mode indicator, not the page.
    manifestEntries().catch(() => []),
  ])
  const s = site.data
  const self = entries.find((e) => e.name === (ctx.env('APP_NAME') ?? 'daedalus'))
  const devServer = self?.sourceMode === 'local'

  return {
    general: {
      hostname: s.hostname,
      baseDomain: s.baseDomain,
      publicUrl: ctx.env('APP_PUBLIC_URL') ?? '',
      // TZ is bound to every container; the export states the same value
      // from the config. Prefer the export, keep env as the pre-export path.
      timezone: s.timezone || (ctx.env('TZ') ?? ''),
      operator: { user: s.operator.user, group: s.operator.group, email: s.mail.alertTo },
      owner: s.owner,
      engine: { revision: site.revision, nixosVersion: s.nixosVersion },
    },
    network: {
      lanIp: s.lanIp || (ctx.env('LAN_IP') ?? ''),
      interface: s.network.interface,
      gateway: s.network.gateway ?? ctx.env('GATEWAY_IP') ?? null,
      wanHost: s.wanHost || (ctx.env('WAN_HOST') ?? ''),
      ddns: { host: ctx.env('DDNS_HOST') ?? '', interval: ctx.env('DDNS_INTERVAL') ?? '' },
      dhcp: network.data.dhcp,
      dns: { upstreams: network.data.dnsUpstreams, lanHosts: network.data.lanHosts.length },
    },
    integrations: {
      cloudflare: {
        accountId: ctx.env('CF_ACCOUNT_ID') ?? '',
        zoneId: ctx.env('CF_ZONE_ID') ?? '',
        tunnelId: ctx.env('CF_TUNNEL_ID') ?? '',
        dnsTokenConfigured: ctx.secret('CF_DNS_TOKEN') !== '',
        apiTokenConfigured: ctx.secret('CF_API_TOKEN') !== '',
      },
      github: {
        owner: s.owner,
        tokenConfigured: ctx.secret('GITHUB_TOKEN') !== '',
        repoTokenConfigured: ctx.secret('GITHUB_REPO_TOKEN') !== '',
      },
      mail: s.mail,
      registryUrl: s.registryUrl,
      grafanaUrl: s.grafanaUrl,
    },
    repository: {
      facts: repo.data,
      meta: meta(repo),
      applyStatus,
      runningRevision: site.revision,
    },
    developer: {
      devServer,
      node: process.version,
      exportDir: ctx.env('EXPORT_DIR') ?? '/export',
      stateRoot: s.stateRoot,
      applyDir: ctx.env('APPLY_DIR') ?? '',
    },
    sources: { site: meta(site), network: meta(network) },
  }
}
