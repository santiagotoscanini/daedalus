// The Network category: everything between a packet and this box.
//
// Ordered the way traffic actually arrives — the WAN link, then the two ways
// in (Cloudflare tunnel from outside, WireGuard for us), then the proxy that
// terminates it, then the resolver every device on the LAN depends on, and
// finally the VPN the download stack exits through.
//
// Two readings here come from prometheus rather than the service's own API,
// and in both cases that is the better source rather than a fallback: MySpeed
// already exports its last test, and wg-easy v2 requires TOTP on /api/session
// so a credential login cannot work unattended at all.

import {
  getJson,
  piholeSid,
  promBars,
  promScalar,
  promScalars,
  promSeries,
  promVector,
} from '../clients'
import { key } from '../format'

export type NetworkData = {
  wan: {
    ping: number | null
    down: number | null
    up: number | null
    /** 7 days of the hourly test, for the two trend lines. */
    downHistory: number[]
    upHistory: number[]
    pingHistory: number[]
  }
  proxy: {
    rpm: number | null
    routers: number | null
    services: number | null
    openConnections: number | null
    byService: { label: string; value: number }[]
    byCode: { label: string; value: number }[]
    spark: number[]
  }
  dns: {
    queries: number | null
    blocked: number | null
    blockedPct: number | null
    gravity: number | null
    topBlocked: { label: string; value: number }[]
    topClients: { label: string; value: number }[]
  }
  tunnel: { status: string | null; connections: number | null }
  wireguard: {
    connected: number | null
    enabled: number | null
    total: number | null
    peers: { name: string; handshakeAgo: number | null; rx: number | null; tx: number | null }[]
  }
  vpn: {
    up: boolean | null
    ip: string | null
    country: string | null
    city: string | null
    port: number | null
  }
  certs: { soonestDays: number | null; expiring: { name: string; days: number }[] }
}

export async function loadNetwork(ctx: {
  base: (app: string) => string
  hc: string
}): Promise<NetworkData> {
  const [
    speed,
    speedHistory,
    proxy,
    overview,
    byService,
    byCode,
    rpmSpark,
    pihole,
    tunnel,
    wg,
    peers,
    vpnIp,
    vpnPort,
    vpnUp,
    certs,
  ] = await Promise.all([
    promScalars({ ping: 'myspeed_ping', down: 'myspeed_download', up: 'myspeed_upload' }),
    // MySpeed tests hourly, so an hourly step is the native resolution — a
    // finer one would just carry each sample forward and draw stairs.
    Promise.all([
      promSeries('myspeed_download', 7 * 24 * 60, 3600),
      promSeries('myspeed_upload', 7 * 24 * 60, 3600),
      promSeries('myspeed_ping', 7 * 24 * 60, 3600),
    ]),
    promScalars({
      rpm: 'sum(rate(traefik_service_requests_total[10m])) * 60',
      connections: 'sum(traefik_open_connections)',
    }),
    getJson<{ http?: { routers?: { total?: number }; services?: { total?: number } } }>(
      'http://traefik:8080/api/overview',
    ),
    promBars(
      'topk(8, sum by (service) (rate(traefik_service_requests_total[10m]) * 60))',
      'service',
      (s) => s.replace(/-svc@file$/, ''),
    ),
    promBars('sum by (code) (rate(traefik_service_requests_total[10m]) * 60)', 'code'),
    promSeries('sum(rate(traefik_service_requests_total[5m])) * 60', 6 * 60, 120),
    loadPihole(ctx.base('pihole')),
    getJson<{ result?: { status?: string; connections?: unknown[] } }>(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID ?? ''}/cfd_tunnel/${
        process.env.CF_TUNNEL_ID ?? ''
      }`,
      { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } },
    ),
    promScalars({
      connected: 'wireguard_connected_peers',
      enabled: 'wireguard_enabled_peers',
      total: 'wireguard_configured_peers',
    }),
    loadPeers(),
    getJson<{ public_ip?: string; country?: string; city?: string }>(
      `${ctx.hc}:8000/v1/publicip/ip`,
    ),
    getJson<{ port?: number }>(`${ctx.hc}:8000/v1/portforward`),
    promScalar('gluetun_vpn_status'),
    promVector('gatus_results_certificate_expiration_seconds'),
  ])

  const expiring = certs
    .map((c) => ({ name: c.metric.name ?? '?', days: Number(c.value[1]) / 86400 }))
    .filter((c) => Number.isFinite(c.days))
    .sort((a, b) => a.days - b.days)

  return {
    wan: {
      ping: speed.ping,
      down: speed.down,
      up: speed.up,
      downHistory: speedHistory[0] ?? [],
      upHistory: speedHistory[1] ?? [],
      pingHistory: speedHistory[2] ?? [],
    },
    proxy: {
      rpm: proxy.rpm,
      routers: overview?.http?.routers?.total ?? null,
      services: overview?.http?.services?.total ?? null,
      openConnections: proxy.connections,
      byService,
      byCode,
      spark: rpmSpark,
    },
    dns: pihole,
    tunnel: {
      status: tunnel?.result?.status ?? null,
      connections: tunnel?.result?.connections?.length ?? null,
    },
    wireguard: { connected: wg.connected, enabled: wg.enabled, total: wg.total, peers },
    vpn: {
      up: vpnUp === null ? null : vpnUp === 1,
      ip: vpnIp?.public_ip ?? null,
      country: vpnIp?.country ?? null,
      city: vpnIp?.city ?? null,
      port: vpnPort?.port ?? null,
    },
    certs: {
      // One number for the whole estate: a single entrypoint-level wildcard
      // covers every hostname (see CLAUDE.md), so these all move together and
      // the soonest one IS the expiry date.
      soonestDays: expiring[0]?.days ?? null,
      expiring: expiring.slice(0, 5),
    },
  }
}

async function loadPihole(base: string): Promise<NetworkData['dns']> {
  const sid = await piholeSid(base)
  const h = sid === null ? {} : { headers: { sid } }

  const [summary, blocked, clients] = await Promise.all([
    getJson<{
      queries?: { total?: number; blocked?: number; percent_blocked?: number }
      gravity?: { domains_being_blocked?: number }
    }>(`${base}/api/stats/summary`, h),
    getJson<{ domains?: { domain?: string; count?: number }[] }>(
      `${base}/api/stats/top_domains?blocked=true&count=6`,
      h,
    ),
    getJson<{ clients?: { name?: string; ip?: string; count?: number }[] }>(
      `${base}/api/stats/top_clients?count=6`,
      h,
    ),
  ])

  return {
    queries: summary?.queries?.total ?? null,
    blocked: summary?.queries?.blocked ?? null,
    blockedPct: summary?.queries?.percent_blocked ?? null,
    gravity: summary?.gravity?.domains_being_blocked ?? null,
    topBlocked: (blocked?.domains ?? []).map((d) => ({
      label: d.domain ?? '?',
      value: d.count ?? 0,
    })),
    // The name is often absent for devices that never announced a hostname to
    // DHCP; the address is the only identifier those have.
    topClients: (clients?.clients ?? []).map((c) => ({
      label: c.name !== undefined && c.name !== '' ? c.name : (c.ip ?? '?'),
      value: c.count ?? 0,
    })),
  }
}

async function loadPeers(): Promise<NetworkData['wireguard']['peers']> {
  const [handshake, rx, tx] = await Promise.all([
    promVector('wireguard_latest_handshake_seconds'),
    promVector('wireguard_received_bytes'),
    promVector('wireguard_sent_bytes'),
  ])

  const by = (v: typeof rx) => new Map(v.map((r) => [r.metric.name ?? '?', Number(r.value[1])]))
  const rxBy = by(rx)
  const txBy = by(tx)

  return handshake
    .map((r) => {
      const seconds = Number(r.value[1])
      return {
        name: r.metric.name ?? '?',
        // The exporter reports 0 for "never", which as an age would render as
        // "just now" — the exact opposite of what it means.
        handshakeAgo: seconds > 0 ? seconds : null,
        rx: rxBy.get(r.metric.name ?? '?') ?? null,
        tx: txBy.get(r.metric.name ?? '?') ?? null,
      }
    })
    .sort((a, b) => (a.handshakeAgo ?? Infinity) - (b.handshakeAgo ?? Infinity))
}
