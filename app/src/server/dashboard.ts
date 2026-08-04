import { createServerFn } from '@tanstack/react-start'

// The Dashboard tab's loader.
//
// Server-side only, and necessarily so: every per-service API key in
// /run/daedalus-dashboard/env is read here, and none of it may cross to the
// browser. What the client receives is the rendered numbers.
//
// One tab at a time. Loading both would double the fan-out — ~30 upstream
// calls — for a page showing half of it, and the tab is a search param so each
// one is its own linkable, server-rendered URL.

export type TabName = 'home' | 'infra'

export const fetchDashboard = createServerFn()
  .inputValidator((input: { tab: TabName }) => input)
  .handler(async ({ data }) => {
    const { GROUPS, TILES } = await import('../lib/dashboard/tiles')
    const { pool, promVector } = await import('../lib/dashboard/clients')
    const { webAppHosts } = await import('../lib/nix-manifest')

    const hosts = await webAppHosts()
    const groups = GROUPS.filter((g) => g.tab === data.tab)
    const names = new Set(groups.map((g) => g.name))
    const tiles = TILES.filter((t) => names.has(t.group))

    const ctx = {
      // A missing webApp is a catalogue bug, not a runtime condition — the
      // manifest carries every published hostname. Falling back to the bare
      // name yields an obviously-broken link rather than a crashed page.
      base: (app: string) => `https://${hosts[app] ?? app}`,
      hc: 'http://host.containers.internal',
    }

    // Status comes from gatus, in one query for every tile: it probes the real
    // public URL from outside, which is the same claim homepage's `siteMonitor`
    // dot made. `container_up` would answer a different question — the unit
    // being active does not mean the service is answering (every Type=oneshot
    // podman unit on this box can be green over a dead container).
    const probes = await promVector('gatus_results_endpoint_success')
    const health = new Map(
      probes.map((p) => [(p.metric.key ?? '').replace(/^web-apps_/, ''), p.value[1] === '1']),
    )

    // Tiles load a few at a time rather than all at once — see `pool`. The
    // catch is the backstop for a `load` that throws despite the helpers: one
    // bad upstream must not blank the page, because "which one is broken" is
    // the whole reason to look at this.
    const loaded = await pool(
      tiles.map((t) => async () => {
        const result =
          t.load === undefined ? { stats: [], note: undefined } : (
            await t.load(ctx).catch(() => ({ stats: [], note: undefined }))
          )
        return {
          key: t.key,
          name: t.name,
          group: t.group,
          description: t.description,
          href: 'url' in t.link ? t.link.url : `${ctx.base(t.link.app)}${t.link.path ?? ''}`,
          // undefined = this tile has no gatus probe (off-box services, and
          // the link-only bookmarks). Rendered as "no probe", not as down.
          up: t.gatus === undefined ? null : (health.get(t.gatus) ?? null),
          stats: result.stats,
          note: result.note ?? null,
        }
      }),
    )

    return {
      tab: data.tab,
      groups: groups.map((g) => ({
        ...g,
        tiles: loaded.filter((t) => t.group === g.name),
      })),
    }
  })

export type DashboardData = Awaited<ReturnType<typeof fetchDashboard>>
export type DashboardTile = DashboardData['groups'][number]['tiles'][number]
