// The Home category: the household's own data — automation, photos, files,
// the pantry, and the SSO directory that gates all of it.
//
// Home Assistant is the one service here worth reading in bulk. `/api/states`
// returns every entity in one response, which is both the cheapest way to get
// a dozen different numbers and the only way to get the ones nobody exposes
// individually (how many lights are on, who is home, which sensors are
// unavailable). Everything else is a single summary endpoint.

import { getJson } from '../clients'
import { key } from '../format'

export type HomeData = {
  hass: {
    reachable: boolean
    people: { name: string; home: boolean }[]
    lightsOn: number
    lightsTotal: number
    switchesOn: number
    entities: number
    unavailable: number
    /** Entity count per domain, biggest first. */
    domains: { label: string; value: number }[]
    /** Indoor temperature sensors, for the strip along the top. */
    temperatures: { label: string; value: number }[]
  }
  photos: {
    users: number | null
    photos: number | null
    videos: number | null
    usageBytes: number | null
  }
  files: {
    freeBytes: number | null
    activeUsers: number | null
    numFiles: number | null
    shares: number | null
    version: string | null
  }
  pantry: {
    missing: number | null
    due: number | null
    overdue: number | null
    expired: number | null
  }
  sso: { clients: number | null; users: number | null }
  finance: { plane: string | null; planeLatest: string | null }
}

export async function loadHome(ctx: {
  base: (app: string) => string
  hc: string
}): Promise<HomeData> {
  const [states, immich, nextcloud, grocy, clients, users, plane] = await Promise.all([
    getJson<{ entity_id: string; state: string; attributes?: Record<string, unknown> }[]>(
      `${ctx.hc}:8123/api/states`,
      { headers: { Authorization: `Bearer ${key('HASS_API_KEY')}` } },
    ),
    getJson<{ photos?: number; videos?: number; usage?: number; usageByUser?: unknown[] }>(
      `${ctx.base('immich')}/api/server/statistics`,
      { headers: { 'x-api-key': key('IMMICH_API_KEY') } },
    ),
    getJson<{
      ocs?: {
        data?: {
          nextcloud?: {
            system?: { freespace?: number; version?: string }
            storage?: { num_files?: number }
            shares?: { num_shares?: number }
          }
          activeUsers?: { last5minutes?: number }
        }
      }
    }>(`${ctx.base('nextcloud')}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json`, {
      headers: { 'NC-Token': key('NEXTCLOUD_KEY'), 'OCS-APIRequest': 'true' },
    }),
    getJson<{
      missing_products?: unknown[]
      due_products?: unknown[]
      overdue_products?: unknown[]
      expired_products?: unknown[]
    }>(`${ctx.base('grocy')}/api/stock/volatile?days=3`, {
      headers: { 'GROCY-API-KEY': key('GROCY_API_KEY') },
    }),
    getJson<{ pagination?: { totalItems?: number } }>(`${ctx.base('pocket-id')}/api/oidc/clients`, {
      headers: { 'X-API-KEY': key('POCKETID_KEY') },
    }),
    getJson<{ pagination?: { totalItems?: number } }>(`${ctx.base('pocket-id')}/api/users`, {
      headers: { 'X-API-KEY': key('POCKETID_KEY') },
    }),
    getJson<{ instance?: { current_version?: string; latest_version?: string } }>(
      `${ctx.base('plane')}/api/instances/`,
    ),
  ])

  const nc = nextcloud?.ocs?.data?.nextcloud

  return {
    hass: summariseStates(states),
    photos: {
      users: immich?.usageByUser?.length ?? null,
      photos: immich?.photos ?? null,
      videos: immich?.videos ?? null,
      // Library size, not disk free: /api/server/storage needs the
      // `server.storage` permission this API key does not carry, and an
      // invented denominator would be worse than the real numerator.
      usageBytes: immich?.usage ?? null,
    },
    files: {
      freeBytes: nc?.system?.freespace ?? null,
      activeUsers: nextcloud?.ocs?.data?.activeUsers?.last5minutes ?? null,
      numFiles: nc?.storage?.num_files ?? null,
      shares: nc?.shares?.num_shares ?? null,
      version: nc?.system?.version ?? null,
    },
    pantry: {
      missing: grocy?.missing_products?.length ?? null,
      due: grocy?.due_products?.length ?? null,
      overdue: grocy?.overdue_products?.length ?? null,
      expired: grocy?.expired_products?.length ?? null,
    },
    sso: {
      clients: clients?.pagination?.totalItems ?? null,
      users: users?.pagination?.totalItems ?? null,
    },
    finance: {
      plane: plane?.instance?.current_version ?? null,
      planeLatest: plane?.instance?.latest_version ?? null,
    },
  }
}

const NO_HASS: HomeData['hass'] = {
  reachable: false,
  people: [],
  lightsOn: 0,
  lightsTotal: 0,
  switchesOn: 0,
  entities: 0,
  unavailable: 0,
  domains: [],
  temperatures: [],
}

function summariseStates(
  states: { entity_id: string; state: string; attributes?: Record<string, unknown> }[] | null,
): HomeData['hass'] {
  if (states === null) return NO_HASS

  const domainOf = (id: string) => id.split('.')[0] ?? '?'
  const inDomain = (d: string) => states.filter((s) => domainOf(s.entity_id) === d)
  const attr = (s: { attributes?: Record<string, unknown> }, k: string) => s.attributes?.[k]
  const nameOf = (s: { entity_id: string; attributes?: Record<string, unknown> }) => {
    const friendly = attr(s, 'friendly_name')
    return typeof friendly === 'string' ? friendly : (s.entity_id.split('.')[1] ?? s.entity_id)
  }

  const domains = new Map<string, number>()
  for (const s of states) domains.set(domainOf(s.entity_id), (domains.get(domainOf(s.entity_id)) ?? 0) + 1)

  const lights = inDomain('light')

  return {
    reachable: true,
    people: inDomain('person').map((s) => ({ name: nameOf(s), home: s.state === 'home' })),
    lightsOn: lights.filter((s) => s.state === 'on').length,
    lightsTotal: lights.length,
    switchesOn: inDomain('switch').filter((s) => s.state === 'on').length,
    entities: states.length,
    // Counted, not listed. 25 Tuya bulbs have been unavailable since they lost
    // their WiFi pairing; a list of them would be the whole panel, and the
    // number is what tells you whether that set has grown.
    unavailable: states.filter((s) => s.state === 'unavailable' || s.state === 'unknown').length,
    domains: [...domains]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    temperatures: states
      .filter(
        (s) =>
          attr(s, 'device_class') === 'temperature' &&
          Number.isFinite(Number(s.state)) &&
          s.state !== 'unavailable',
      )
      .map((s) => ({ label: nameOf(s), value: Number(s.state) }))
      .slice(0, 6),
  }
}
