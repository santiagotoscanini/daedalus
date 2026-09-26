import { readApplyStatus } from '../../host/apply'
import { networkSnapshot } from '../../host/contract/domains/network'
import { repoFacts } from '../../host/contract/domains/repo'
import { type SiteIdentity, siteIdentity } from '../../host/contract/domains/site'
import type { SnapshotResult } from '../../host/contract/snapshot'
import type { Ctx } from '../ctx'
import type { BoxSettings, SourceMeta } from './types'

// The reader behind Settings: what this box IS, assembled from the three
// places a fact can already reach the container — env bound by daedalus.nix,
// the /export domains, and the host snapshots. Nothing here is editable and
// nothing here is guessed: a value the box has not stated renders as absent,
// which is the honest reading of "not configured". The editable half — the
// site repository's desired document — is core/site's.

const meta = (r: SnapshotResult<unknown>): SourceMeta => ({
  available: r.available,
  stale: r.stale,
  generatedAt: r.generatedAt,
  error: r.error,
})

/**
 * The control plane's label: site.json's when it carries one, else read off
 * the address the box answers at.
 */
function controlPlaneOf(s: SiteIdentity): BoxSettings['general']['controlPlane'] {
  const host = s.controlPlane.hostname ?? ''
  const suffix = `.${s.baseDomain}`
  const derived = s.baseDomain !== '' && host.endsWith(suffix) ? host.slice(0, -suffix.length) : ''
  return { label: s.controlPlane.label ?? derived, previousLabel: s.controlPlane.previousLabel }
}

export async function readBoxSettings(ctx: Ctx): Promise<BoxSettings> {
  const [site, network, repo, applyStatus] = await Promise.all([
    siteIdentity(),
    networkSnapshot(),
    repoFacts(),
    readApplyStatus(),
  ])
  const s = site.data
  // The one fact about how THIS app is run: fleet.daedalus.dev sets it on the
  // container (nix/stacks/daedalus/daedalus.nix), and the entrypoint reads the
  // same variable to decide between the bundle and the dev server.
  const devServer = ctx.env('DAEDALUS_DEV') === '1'

  return {
    general: {
      hostname: s.hostname,
      baseDomain: s.baseDomain,
      publicUrl: ctx.env('APP_PUBLIC_URL') ?? '',
      controlPlane: controlPlaneOf(s),
      timezone: s.timezone,
      operator: { user: s.operator.user, group: s.operator.group, email: s.mail.alertTo },
      owner: s.owner,
    },
    network: {
      lanIp: s.lanIp,
      interface: s.network.interface,
      gateway: s.network.gateway,
      wanHost: s.wanHost,
      ddns: { host: ctx.env('DDNS_HOST') ?? '', interval: ctx.env('DDNS_INTERVAL') ?? '' },
      dhcp: network.data.dhcp,
      dns: { upstreams: network.data.dnsUpstreams, lanHosts: network.data.lanHosts.length },
    },
    integrations: {
      cloudflare: {
        accountId: ctx.env('CF_ACCOUNT_ID') ?? '',
        zoneId: ctx.env('CF_ZONE_ID') ?? '',
        tunnelId: ctx.env('CF_TUNNEL_ID') ?? '',
        tokenConfigured: ctx.secret('CF_API_TOKEN') !== '',
      },
      github: { owner: s.owner },
      mail: s.mail,
      registryUrl: s.registryUrl,
      grafanaUrl: s.grafanaUrl,
    },
    repository: {
      facts: repo.data,
      meta: meta(repo),
      applyStatus,
      runningRevision: site.revision,
      git: s.git,
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
