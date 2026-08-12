import { localDay } from '../../../format'
import { getJson } from '../../../http'
import { lokiLatest } from '../../../loki'
import { promPoints, promScalar, promVector } from '../../../prom'
import { declaredVpnEgress, type VpnEgress } from '../../../vpn-egress'
import {
  type CommitGap,
  commitsSince,
  EMPTY_COMMITS,
  EMPTY_GAP,
  type VersionGap,
  versionGap,
} from '../../github'
import { DAYS } from './shared'

/**
 * One VPN egress tunnel.
 *
 * Assembled from three sources that each know something the others cannot:
 * nix (what the tunnel is for, when its key dies, where the runbook is),
 * gluetun's control API (where it currently comes out), and prometheus (how
 * reliable it has been, and what is riding it right now).
 */
type Tunnel = {
  key: string
  subject: string
  container: string
  exporter: string
  provider: string
  runbook: string
  portForwarding: boolean
  up: boolean | null
  /** Days until the WireGuard key expires. Negative once it has. */
  expiryDays: number
  keyExpiry: string
  /** Where this tunnel surfaces, from the provider's own view of it. */
  exit: {
    ip: string | null
    country: string | null
    city: string | null
    region: string | null
    org: string | null
    timezone: string | null
  }
  /** The provider-forwarded port, when this instance asks for one. */
  port: number | null
  /** Share of the last 7 days the tunnel reported itself up. */
  uptime7d: number | null
  /** Same, per day, oldest first — the shape a drop actually has. */
  daily: { date: string; uptime: number }[]
  /** Containers sharing this netns, so they lose the network with it. */
  tenants: { name: string; up: boolean | null }[]
}

export type OutboundData = {
  tunnels: Tunnel[]
  /**
   * The software, which is shared by every tunnel on the page.
   *
   * Both instances come out of one `mkGluetunInstance`, which pins ONE image
   * digest for gluetun and one for the exporter — so however many tunnels are
   * declared, they are always the same two builds. Reporting it per tunnel
   * would print the same answer twice and invite the reader to check whether
   * they differ.
   */
  gluetun: CommitGap
  exporter: VersionGap
  note: string | null
}

// ── Egress: the ways out ───────────────────────────────────────────────────

/**
 * One entry per gluetun instance, from `fleet.vpnEgress`.
 *
 * The list is nix's, deliberately: a third tunnel registers itself from the
 * `mkGluetunInstance` call that creates it, so this page grows without being
 * told. Everything time-varying is fetched per instance and in parallel —
 * where it comes out now, how reliable it has been, and which containers are
 * currently sharing its namespace.
 */
export async function loadOutbound(ctx: { hc: string }): Promise<OutboundData> {
  const declared = await declaredVpnEgress()

  if (declared.length === 0) {
    return {
      tunnels: [],
      gluetun: EMPTY_COMMITS,
      exporter: EMPTY_GAP,
      note:
        'No VPN egress declared. The list comes from fleet.vpnEgress, which ' +
        'mkGluetunInstance fills in — see platform/gluetun-lib.nix.',
    }
  }

  const liveness = await promVector('container_up')
  const upOf = (name: string): boolean | null => {
    const hit = liveness.find((r) => r.metric.name === name)
    return hit === undefined ? null : hit.value[1] === '1'
  }

  const [tunnels, gluetun, exporter] = await Promise.all([
    Promise.all(declared.map((d) => loadTunnel(d, ctx.hc, upOf))),
    // Read from the first instance's banner, and correct for all of them:
    // `mkGluetunInstance` pins one image digest, so a second tunnel is the
    // same binary. See `OutboundData.gluetun`.
    gluetunBuild(declared[0]?.container ?? ''),
    // No running version to compare against, deliberately unfaked: the image
    // is a digest-pinned `:latest` and the exporter prints no version in its
    // log, serves none on /metrics, and has no endpoint that would say. So
    // this lists what EXISTS and the panel says it cannot tell you which of it
    // is running — which is the true statement, and still tells you a release
    // came out.
    versionGap('thecfu/gluetun-exporter', null, { notesWhenUnknown: true }),
  ])

  return { tunnels, gluetun, exporter, note: null }
}

/** The commit gluetun states in its startup banner, and master since it. */
async function gluetunBuild(container: string): Promise<CommitGap> {
  if (container === '') return EMPTY_COMMITS
  const banner = await lokiLatest(`{container=${JSON.stringify(container)}} |= "Running version"`)
  // `Running version latest built on 2026-07-29T…Z (commit b00279b) on Linux …`
  const commit = /\(commit ([0-9a-f]{7,40})\)/.exec(banner ?? '')?.[1] ?? null
  return commitsSince('qdm12/gluetun', commit)
}

async function loadTunnel(
  d: VpnEgress,
  hc: string,
  upOf: (name: string) => boolean | null,
): Promise<Tunnel> {
  const control = `${hc}:${String(d.controlPort)}`
  const job = JSON.stringify(d.job)

  const [ip, port, up, uptime7d, daily] = await Promise.all([
    // The provider's own view of where this tunnel surfaces. Nothing on this
    // box can answer it — the container sees a tun0 with a private address,
    // and the exit address is only knowable from outside.
    getJson<{
      public_ip?: string
      country?: string
      city?: string
      region?: string
      organization?: string
      timezone?: string
    }>(`${control}/v1/publicip/ip`),
    d.portForwarding ? getJson<{ port?: number }>(`${control}/v1/portforward`) : null,
    promScalar(`gluetun_vpn_status{job=${job}}`),
    promScalar(`avg_over_time(gluetun_vpn_status{job=${job}}[7d])`),
    promPoints(`avg_over_time(gluetun_vpn_status{job=${job}}[1d])`, DAYS * 24 * 60, 86400),
  ])

  const expiry = Date.parse(`${d.keyExpiry}T00:00:00Z`)

  return {
    key: d.container,
    subject: d.subject,
    provider: d.provider,
    container: d.container,
    exporter: d.exporter,
    runbook: d.runbook,
    portForwarding: d.portForwarding,
    up: up === null ? null : up === 1,
    keyExpiry: d.keyExpiry,
    expiryDays: Math.round((expiry - Date.now()) / 86400_000),
    exit: {
      ip: ip?.public_ip ?? null,
      country: ip?.country ?? null,
      city: ip?.city ?? null,
      region: ip?.region ?? null,
      // "AS9009 M247 Europe SRL" — the provider's carrier, which is what an
      // observer on the far side actually sees this traffic as.
      org: ip?.organization ?? null,
      timezone: ip?.timezone ?? null,
    },
    // A forwarded port of 0 is gluetun for "none yet", not port zero.
    port: port?.port !== undefined && port.port > 0 ? port.port : null,
    uptime7d,
    daily: daily.map((p) => ({ date: localDay(p.t * 1000), uptime: p.v })),
    // The exporter is in the list because it genuinely rides the tunnel, and
    // dropping it would misreport what a tunnel outage takes down.
    tenants: d.tenants.map((name) => ({ name, up: upOf(name) })),
  }
}
