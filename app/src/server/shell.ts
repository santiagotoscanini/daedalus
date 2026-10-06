import { readFn } from './fn'
import { fetchActiveModules } from './modules'
import { fetchTheme } from './settings'
import { fetchEngineOverride, fetchSite } from './site'

// Everything the document shell is drawn from, in ONE round trip: the
// theme (the palette is in the head), the rail's rows, the box's identity
// and the engine-override notice. As four server calls from the root loader
// they would be four round trips on every navigation past the stale window;
// each is a file read or a row, and together they are one small answer.
export const fetchShell = readFn.handler(async () => {
  const [theme, modules, site, engineOverride] = await Promise.all([
    fetchTheme(),
    fetchActiveModules(),
    fetchSite(),
    fetchEngineOverride(),
  ])
  return { theme, modules, site, engineOverride }
})

/**
 * How the controller link stands, for the shell's banner. While it is not
 * connected this asks the controller once — a dial the client's backoff
 * already paces — so a controller that came back while nothing called it
 * clears the banner at the next poll rather than at the next page that asks.
 */
export const fetchControllerLinkFn = readFn.handler(async ({ context }) => {
  const { controller } = await context.ctx()
  if (controller.link().state !== 'connected') {
    await controller.call('system.info').catch(() => undefined)
  }
  return controller.link()
})

/** The rail's dots, by module id (host/rail-badges.ts). Polled by the shell. */
export const fetchRailBadgesFn = readFn.handler(async ({ context }) => {
  const { railBadges } = await import('../host/rail-badges')
  return railBadges(await context.ctx())
})

/**
 * What the ⌘K palette can jump to beyond the pages the rail already knows:
 * the apps by name and the approved machines. Names only — the palette is a
 * way to arrive somewhere, and the page it opens reads the rest.
 */
export const fetchPaletteFn = readFn.handler(async ({ context }) => {
  const [{ listAppNames }, { listNodes }] = await Promise.all([
    import('../lib/repo/apps'),
    import('../lib/repo/nodes'),
  ])
  const [apps, nodes] = await Promise.all([listAppNames(), listNodes(await context.ctx())])
  return {
    apps,
    machines: nodes.filter((n) => n.state === 'approved').map((n) => ({ id: n.id, name: n.name })),
  }
})
