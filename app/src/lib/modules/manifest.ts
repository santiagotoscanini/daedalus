// What a dashboard module declares about itself, and nothing more.
//
// A module is a directory under `src/modules/<id>/` holding exactly this
// manifest, a `data/` tree the server loads, a `view/` tree the browser
// renders, and optionally the release sources of the containers it fronts.
// The registry (`./registry.ts`) finds every manifest with `import.meta.glob`,
// so adding a module is adding a directory — no list to append to, no
// record to extend, no switch to grow a case.
//
// This file is PURE and CLIENT-SAFE: the rail renders every manifest on
// every page, so a manifest may hold data only. Anything a tab needs from
// the machine lives in its `data/` module and arrives through a `Ctx`.

export type TabHealth = 'vpn-egress' | 'uplink' | 'log-pipeline'

export type TabSpec = {
  id: string
  label: string
  /**
   * A gatus endpoint name — the tab wears its subject's status as a dot, so
   * a module of several servers answers "which of these is up" from the tab
   * row. Omitted means nothing probes this tab's subject, which is not the
   * same claim as "down" and is drawn grey.
   */
  probe?: string
  /**
   * Several probes that must ALL be green, for a tab whose subject is more
   * than one service. Picking one to represent the pair would draw a green
   * dot over a broken half; unknown on any of them makes the whole thing
   * unknown.
   */
  probes?: readonly string[]
  /**
   * A COMPUTED status, for a tab gatus cannot probe. A symbol rather than a
   * query, because the assembly needs the registry, which lives on the
   * server; this file must stay data.
   */
  health?: TabHealth
  /**
   * This tab's opening shape, when it differs from the module's. The
   * SKELETON has to know it before the data exists.
   */
  boardSpans?: readonly number[]
  /** Draw a rule before this tab: it answers a different KIND of question. */
  dividerBefore?: boolean
  /** Whether this tab opens with a `ServiceHead`. Default true. */
  head?: boolean
  /**
   * The nix module(s) this tab fronts — `fleet.modules.<id>` on the box. A
   * tab whose nix modules are all disabled is not offered, and a module
   * whose tabs are all gone leaves the rail. Omitted means the tab is about
   * the box itself and is always shown.
   */
  nix?: string | readonly string[]
}

export type ModuleManifest = {
  /** Also the directory name and the URL segment: `/c/<id>`. */
  id: string
  label: string
  lede: string
  /**
   * Column spans of the default tab's boards, for the skeleton. Only the
   * first few matter — the fold is around four boards.
   */
  boardSpans: readonly number[]
  /** Position in the rail. Modules sort by this, then by id. */
  order: number
  tabs: readonly TabSpec[]
  /**
   * The page has a machine picker above its tabs: this box, then every
   * approved node. Picking a node replaces the tabs with that machine's own
   * (System's mirror the box's: components/machine-system/); the box's tabs
   * are what the module declares. Only a page whose subject exists on every
   * machine sets it — and the rail draws that module below the directory,
   * on its own, since it is about the fleet rather than this box.
   */
  machinePicker?: boolean
}

/** What a category page needs to draw its frame — a manifest minus its rail position. */
export type PageSpec = Omit<ModuleManifest, 'order'>

/** The nix modules a tab fronts, as a list. */
export function nixModulesOf(tab: TabSpec): readonly string[] {
  if (tab.nix === undefined) return []
  return typeof tab.nix === 'string' ? [tab.nix] : tab.nix
}

/** Whether a tab wears a dot at all — any of the three ways of declaring one. */
export function isDotted(tab: TabSpec): boolean {
  return tab.probe !== undefined || tab.probes !== undefined || tab.health !== undefined
}

/**
 * The tab a request names, or the module's first when it names none or one
 * the module does not have — the behaviour a stale link depends on.
 */
export function resolveTabOf(spec: PageSpec, tab: string | undefined): string {
  return tab !== undefined && spec.tabs.some((t) => t.id === tab) ? tab : (spec.tabs[0]?.id ?? '')
}
