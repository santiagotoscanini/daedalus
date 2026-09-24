import { type ModuleManifest, nixModulesOf } from './manifest'

// Which modules the rail offers, and which of their tabs are switched off.
//
// A tab fronts nix modules (`TabSpec.nix`). One of three things is true of
// each on this box: it is on, it is declared and switched off, or the box
// does not import it at all. A tab whose nix modules are all ABSENT is not
// offered — the box has nothing to show and nothing to switch. A tab whose
// nix modules are all OFF stays, marked `off`: its page draws the switch
// rather than the boards, so a service switched off from its own page is
// still one click from on again, and the rail says what the box could run.
// A tab with none is always offered (the box's own pages).

export type ModuleState = 'on' | 'off' | 'absent'

export function activeModules(
  modules: readonly ModuleManifest[],
  state: (nixModule: string) => ModuleState,
): ModuleManifest[] {
  return modules.flatMap((m) => {
    const tabs = m.tabs.flatMap((t) => {
      const nix = nixModulesOf(t)
      if (nix.length === 0) return [t]
      const states = nix.map(state)
      if (states.every((s) => s === 'absent')) return []
      return [states.some((s) => s === 'on') ? t : { ...t, off: true }]
    })
    return tabs.length === 0 ? [] : [{ ...m, tabs }]
  })
}
