import { type ModuleManifest, nixModulesOf, type TabBrand, type TabFace } from './manifest'

// Which modules the rail offers, which of their tabs are switched off, and
// what the box calls the tabs it names.
//
// A tab fronts nix modules (`TabSpec.nix`). One of three things is true of
// each on this box: it is on, it is declared and switched off, or the box
// does not import it at all. A tab whose nix modules are all ABSENT is not
// offered — the box has nothing to show and nothing to switch. A tab whose
// nix modules are all OFF stays, marked `off`: its page draws the switch
// rather than the boards, so a service switched off from its own page is
// still one click from on again, and the rail says what the box could run.
// A tab with none is always offered (the box's own pages).
//
// A tab with a `brand` takes its label and logo from `faces` when the box
// resolved one, so the tab row and the palette say the same name.

export type ModuleState = 'on' | 'off' | 'absent'

export function activeModules(
  modules: readonly ModuleManifest[],
  state: (nixModule: string) => ModuleState,
  faces: Partial<Record<TabBrand, TabFace | null>> = {},
): ModuleManifest[] {
  return modules.flatMap((m) => {
    const tabs = m.tabs.flatMap((t) => {
      const face = t.brand === undefined ? null : (faces[t.brand] ?? null)
      const named = face === null ? t : { ...t, label: face.label, logo: face.logo }
      const nix = nixModulesOf(t)
      if (nix.length === 0) return [named]
      const states = nix.map(state)
      if (states.every((s) => s === 'absent')) return []
      return [states.some((s) => s === 'on') ? named : { ...named, off: true }]
    })
    return tabs.length === 0 ? [] : [{ ...m, tabs }]
  })
}
