import { createContext, type ReactNode, useContext } from 'react'
import { type Site, UNBOUND_SITE } from './site'

// The browser's one way to the box's identity. The root route's loader reads
// it on the server and the shell provides it, so the value is in the
// server-rendered HTML and in the dehydrated loader data: hydration renders
// the same hostnames the server did, with no effect-time fetch in between.

const SiteContext = createContext<Site>(UNBOUND_SITE)

export function SiteProvider({ site, children }: { site: Site; children: ReactNode }) {
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>
}

/** The box's identity. Outside the root provider it reads as unbound, never as some box. */
export const useSite = (): Site => useContext(SiteContext)
