// The pure half of switching a module: the shape a page draws, and the
// reasons the structural ones stay on. Client-safe on purpose — the settings
// tab and the service dialog import from here; the reads and the writes are
// in core/site/switches.ts, which needs the machine.

/** One published hostname as the operator may move it: null keeps the host's word. */
export type WebOverride = { label: string | null; public: boolean | null }

/**
 * One hostname a module publishes, as the running system has it and as the
 * document would move it. `name` is `fleet.webApps.<name>`, which is what
 * the document keys on; `label` is the one label under the base domain,
 * which is all the operator may edit.
 */
export type ModuleWeb = {
  name: string
  /** As built: the hostname, its label, and whether the tunnel carries it. */
  hostname: string
  label: string
  public: boolean
  aliases: string[]
  /** The document's word, committed and as the next Apply would build it. */
  committed: WebOverride
  desired: WebOverride
}

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
  /** Every hostname the module publishes, aliases included, as built. */
  hostnames: string[]
  /** The same hostnames, one entry per webApp, with what the operator moved. */
  web: ModuleWeb[]
}

/** What the next Apply would publish for one entry: the moved label, else the built one. */
export function webLabelAfter(w: ModuleWeb): string {
  return w.desired.label ?? w.label
}

/** Whether the tunnel would carry it after the next Apply. */
export function webPublicAfter(w: ModuleWeb): boolean {
  return w.desired.public ?? w.public
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
 * "grocy at pantry", "grocy public", "grocy on the LAN only", "grocy as the
 * host says": the words the Apply bar shows for `modules.web`, one per
 * webApp whose entry moved.
 */
export function webChangeWords(
  committed: Record<string, WebOverride> | undefined,
  desired: Record<string, WebOverride>,
): string[] {
  const before = committed ?? {}
  const none: WebOverride = { label: null, public: null }
  const names = new Set([...Object.keys(before), ...Object.keys(desired)])
  return [...names].sort().flatMap((n) => {
    const a = before[n] ?? none
    const b = desired[n] ?? none
    const words: string[] = []
    if (a.label !== b.label)
      words.push(b.label === null ? `${n} at its own name` : `${n} at ${b.label}`)
    if (a.public !== b.public) {
      words.push(
        b.public === null
          ? `${n} exposed as the host says`
          : b.public
            ? `${n} public`
            : `${n} on the LAN only`,
      )
    }
    return words
  })
}

/** One account on a game server's roster (core/site/file.ts `SitePlayer`). */
export type RosterPlayer = { name: string; uuid: string; op: boolean }

/**
 * "minecraft: alice in", "minecraft: bob out", "minecraft: alice op",
 * "minecraft: alice not op": the words the Apply bar shows for
 * `modules.players`, one per account that moved. Matched on the uuid, so a
 * rename is not an out-and-in.
 */
export function playerChangeWords(
  committed: Record<string, RosterPlayer[]> | undefined,
  desired: Record<string, RosterPlayer[]>,
): string[] {
  const before = committed ?? {}
  const ids = new Set([...Object.keys(before), ...Object.keys(desired)])
  return [...ids].sort().flatMap((id) => {
    const a = new Map((before[id] ?? []).map((p) => [p.uuid, p]))
    const b = new Map((desired[id] ?? []).map((p) => [p.uuid, p]))
    const words: string[] = []
    for (const [uuid, p] of b) {
      const was = a.get(uuid)
      if (was === undefined) words.push(`${id}: ${p.name} in${p.op ? ' as op' : ''}`)
      else if (was.op !== p.op) words.push(`${id}: ${p.name} ${p.op ? 'op' : 'not op'}`)
    }
    for (const [uuid, p] of a) if (!b.has(uuid)) words.push(`${id}: ${p.name} out`)
    return words
  })
}

/**
 * The site fields the Apply bar lists: every changed field by name, except
 * the module fields, which are spelled out per entry ("n8n off") — the
 * field's name says nothing anyone would click Apply for.
 */
export function siteBarFields(
  changes: readonly string[],
  moduleChanges: readonly string[],
): string[] {
  return [
    ...changes.filter(
      (f) => f !== 'modules.enabled' && f !== 'modules.web' && f !== 'modules.players',
    ),
    ...moduleChanges,
  ]
}
