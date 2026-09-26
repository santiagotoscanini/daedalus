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
