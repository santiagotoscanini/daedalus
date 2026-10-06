import type { NavigateOptions } from '@tanstack/react-router'
import type { ModuleManifest } from '../../lib/modules/manifest'
import type { NavIconName } from '../nav-icon'

// What the ⌘K palette offers, and how a typed query ranks it.
//
// Pure: the palette component hands in what the shell already holds (the
// module manifests) plus the one read it makes (apps and machines), and gets
// back a flat list. Every entry either NAVIGATES — the same routes the rail
// and the tab rows link to — or runs one of the few verbs that already live
// in the chrome (the theme, the rail's collapse). Nothing here can do what a
// page's own buttons could not.

export type PaletteGroup = 'Pages' | 'Apps' | 'Machines' | 'Settings' | 'Actions'

export type PaletteItem = {
  id: string
  group: PaletteGroup
  label: string
  /** A quieter word on the right: where it goes, or what it is. */
  hint?: string
  icon: NavIconName | 'search' | 'sun' | 'moon' | 'monitor' | 'sidebar' | 'logout' | 'plus'
  /** Extra words the query may match that the label does not say. */
  keywords?: string
  /** Offered only once something is typed: the long tail (an app's tabs). */
  deep?: boolean
  action:
    | { kind: 'go'; to: NavigateOptions }
    | { kind: 'href'; href: string }
    | { kind: 'run'; verb: PaletteVerb }
}

export type PaletteVerb = 'theme-light' | 'theme-dark' | 'theme-system' | 'toggle-rail'

/** The settings tabs, in the page's order (routes/settings.tsx TABS). */
const SETTINGS_TABS: readonly [id: string, label: string, keywords: string][] = [
  ['general', 'General', 'identity hostname domain timezone'],
  ['network', 'Network', 'dhcp dns lan addresses'],
  ['integrations', 'Integrations', 'cloudflare github vercel token mcp'],
  ['repository', 'Site', 'repository config git'],
  ['machines', 'Machines', 'nodes agent policy'],
  ['modules', 'Modules', 'catalog enable stacks'],
  ['appearance', 'Appearance', 'theme preset colour color'],
  ['developer', 'Developer', 'engine override'],
]

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function buildItems(
  modules: readonly ModuleManifest[],
  appTabs: readonly string[],
  data: { apps: string[]; machines: { id: string; name: string }[] } | null,
): PaletteItem[] {
  const items: PaletteItem[] = [
    {
      id: 'apps',
      group: 'Pages',
      label: 'Apps',
      icon: 'apps',
      action: { kind: 'go', to: { to: '/apps' } },
    },
    {
      id: 'apps-new',
      group: 'Actions',
      label: 'Add an app',
      hint: 'New',
      icon: 'plus',
      keywords: 'create new app deploy',
      action: { kind: 'go', to: { to: '/apps/new' } },
    },
  ]

  for (const m of modules) {
    items.push({
      id: `m:${m.id}`,
      group: 'Pages',
      label: m.label,
      icon: m.id as NavIconName,
      keywords: m.lede,
      action: { kind: 'go', to: { to: '/c/$category', params: { category: m.id }, search: {} } },
    })
    for (const t of m.tabs) {
      items.push({
        id: `m:${m.id}:${t.id}`,
        group: 'Pages',
        label: `${m.label} › ${t.label}`,
        icon: m.id as NavIconName,
        hint: t.off === true ? 'off' : undefined,
        deep: true,
        action: {
          kind: 'go',
          to: { to: '/c/$category', params: { category: m.id }, search: { tab: t.id } },
        },
      })
    }
  }

  const picker = modules.find((m) => m.machinePicker === true)
  for (const n of data?.machines ?? []) {
    items.push({
      id: `n:${n.id}`,
      group: 'Machines',
      label: n.name,
      hint: picker?.label ?? 'System',
      icon: 'system',
      keywords: 'machine node computer',
      action: {
        kind: 'go',
        to: {
          to: '/c/$category',
          params: { category: picker?.id ?? 'system' },
          search: { machine: n.id },
        },
      },
    })
  }

  for (const name of data?.apps ?? []) {
    items.push({
      id: `a:${name}`,
      group: 'Apps',
      label: name,
      hint: 'App',
      icon: 'overview',
      action: { kind: 'go', to: { to: '/apps/$name', params: { name } } },
    })
    for (const tab of appTabs) {
      if (tab === 'overview') continue
      items.push({
        id: `a:${name}:${tab}`,
        group: 'Apps',
        label: `${name} › ${title(tab)}`,
        icon: tab as NavIconName,
        deep: true,
        action: { kind: 'go', to: { to: '/apps/$name', params: { name }, search: { tab } } },
      })
    }
  }

  items.push({
    id: 's',
    group: 'Settings',
    label: 'Settings',
    icon: 'settings',
    action: { kind: 'go', to: { to: '/settings' } },
  })
  for (const [id, label, keywords] of SETTINGS_TABS) {
    items.push({
      id: `s:${id}`,
      group: 'Settings',
      label: `Settings › ${label}`,
      icon: 'settings',
      keywords,
      deep: true,
      action: { kind: 'go', to: { to: '/settings', search: { tab: id } } },
    })
  }
  items.push(
    {
      id: 'profile',
      group: 'Settings',
      label: 'Profile',
      icon: 'access',
      keywords: 'account passkeys me',
      action: { kind: 'go', to: { to: '/profile' } },
    },
    {
      id: 'theme-dark',
      group: 'Actions',
      label: 'Use the dark theme',
      icon: 'moon',
      keywords: 'appearance scheme night',
      action: { kind: 'run', verb: 'theme-dark' },
    },
    {
      id: 'theme-light',
      group: 'Actions',
      label: 'Use the light theme',
      icon: 'sun',
      keywords: 'appearance scheme day',
      action: { kind: 'run', verb: 'theme-light' },
    },
    {
      id: 'theme-system',
      group: 'Actions',
      label: 'Follow the system theme',
      icon: 'monitor',
      keywords: 'appearance scheme auto',
      action: { kind: 'run', verb: 'theme-system' },
    },
    {
      id: 'rail',
      group: 'Actions',
      label: 'Collapse or expand the sidebar',
      icon: 'sidebar',
      keywords: 'rail navigation',
      action: { kind: 'run', verb: 'toggle-rail' },
    },
    {
      id: 'logout',
      group: 'Actions',
      label: 'Sign out',
      icon: 'logout',
      keywords: 'log out logout',
      action: { kind: 'href', href: '/logout' },
    },
  )
  return items
}

/**
 * How well `q` matches `text`, or null. A prefix beats a word start beats a
 * substring beats letters in order — the four ways a person abbreviates.
 */
function score(text: string, q: string): number | null {
  const t = text.toLowerCase()
  if (t.startsWith(q)) return 100 - t.length / 100
  const at = t.indexOf(q)
  if (at > 0 && /[\s›·\-/]/.test(t.charAt(at - 1))) return 80 - at / 100
  if (at > 0) return 60 - at / 100
  let i = 0
  for (const ch of t) if (ch === q.charAt(i)) i++
  return i === q.length ? 30 - t.length / 100 : null
}

/** The items a query shows, best first; with no query, the shallow ones in order. */
export function rank(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items.filter((i) => i.deep !== true)
  // Every word must match somewhere; the item scores by its best fields.
  const words = q.split(/\s+/)
  const scored: { item: PaletteItem; s: number }[] = []
  for (const item of items) {
    let total = 0
    let ok = true
    for (const w of words) {
      const s = Math.max(score(item.label, w) ?? -1, (score(item.keywords ?? '', w) ?? -1) - 25)
      if (s < 0) {
        ok = false
        break
      }
      total += s
    }
    // The shallow entry wins a tie with its own tabs: "iris" opens iris.
    if (ok) scored.push({ item, s: total - (item.deep === true ? 5 : 0) })
  }
  // A strong match makes the letters-in-order tail noise: keep what scores
  // within reach of the best.
  scored.sort((a, b) => b.s - a.s)
  const floor = (scored[0]?.s ?? 0) * 0.55
  return scored
    .filter((x) => x.s >= floor)
    .map((x) => x.item)
    .slice(0, 40)
}
