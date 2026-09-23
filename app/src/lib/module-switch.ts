// The pure half of switching a module: the shape a page draws, and the
// reasons the structural ones stay on. Client-safe on purpose — the settings
// tab and the page footer import from here; the reads and the write are in
// core/site/switches.ts, which needs the machine.

export type ModuleSwitch = {
  id: string
  /** As the running system was built. */
  running: boolean
  /** As the next Apply would build it: the document's word, else the running one. */
  desired: boolean
  /** The document names it — a switch the operator moved. */
  switched: boolean
  structural: boolean
  containers: string[]
  hostnames: string[]
}

/**
 * Why a structural module stays on, in a sentence each, for the ones the
 * engine and the reference host name. An id not listed here is structural
 * without a story, which the page states as such.
 */
export const STRUCTURAL_WHY: Record<string, string> = {
  traefik: 'every published hostname rides it',
  'pocket-id': 'it gates the control plane you are reading',
  'app-db': 'the cluster every app and most stacks ride',
  pihole: 'the box resolves through it, and so does the house',
  registry: 'the apps pull from it and the builder pushes to it',
  logging: 'the log pipeline the pages read',
  monitoring: 'the metrics every page reads',
  apps: 'daedalus is an app on it',
  daedalus: 'this',
  cloudflared: 'the tunnel the live hostnames answer through',
  gatus: 'the probes every tab wears as a dot',
  healthchecks: 'the dead-man pings the alerts rely on',
  litellm: 'its MCP sidecars write into another stack’s bridge',
  downloads: 'a netns owner — ten tenants ride it',
  'argus-vpn': 'a netns owner with tenants',
  verdaccio: 'the build agent installs through it',
  'grocy-mcp': 'Open WebUI’s gateway key names its MCP server',
  'yazio-mcp': 'Open WebUI’s gateway key names its MCP server',
  wealthfolio: 'Open WebUI’s gateway key names its MCP server',
}

/** "n8n off", "metube on": the words the Apply bar shows for the field. */
export function moduleChangeWords(
  committed: Record<string, boolean> | undefined,
  desired: Record<string, boolean>,
): string[] {
  const before = committed ?? {}
  const ids = new Set([...Object.keys(before), ...Object.keys(desired)])
  return [...ids]
    .sort()
    .filter((id) => before[id] !== desired[id])
    .map((id) =>
      id in desired ? `${id} ${desired[id] === true ? 'on' : 'off'}` : `${id} as the host says`,
    )
}

/**
 * The site fields the Apply bar lists: every changed field by name, except
 * the switches field, which is spelled out per module ("n8n off") — the
 * field's name says nothing anyone would click Apply for.
 */
export function siteBarFields(
  changes: readonly string[],
  moduleChanges: readonly string[],
): string[] {
  return [...changes.filter((f) => f !== 'modules.enabled'), ...moduleChanges]
}
