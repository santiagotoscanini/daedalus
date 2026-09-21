import { type ModuleManifest, nixModulesOf } from './manifest'

// Which modules the box can still show, given which nix modules it runs.
//
// Pure, so the rule is one test: a tab that fronts nix modules is kept while
// ANY of them is enabled (a tab of two services with one turned off still has
// something to say), a tab that fronts none is always kept, and a module
// keeps its place in the rail only while it has a tab left.

export function activeModules(
  modules: readonly ModuleManifest[],
  enabled: (nixModule: string) => boolean,
): ModuleManifest[] {
  return modules.flatMap((m) => {
    const tabs = m.tabs.filter((t) => {
      const nix = nixModulesOf(t)
      return nix.length === 0 || nix.some(enabled)
    })
    return tabs.length === 0 ? [] : [{ ...m, tabs }]
  })
}
