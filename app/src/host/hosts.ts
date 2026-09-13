import { webAppHosts } from './nix-manifest'

// Where a dashboard loader dials, and nothing else.
//
// This is NOT core/ctx.ts's `Ctx`. That one is a capability set — env, secret,
// snapshot, store, http, loki — handed to a reader so it never reaches for the
// machine itself. This is two strings' worth of addressing, read from the nix
// manifest, and it is all a category tab needs to know about where a service
// lives. They were both called `Ctx`, both built by a `makeCtx`, and which one
// `await makeCtx()` meant depended on the file it was written in.

export type Hosts = {
  /**
   * `https://<hostname>` for a published webApp.
   *
   * A missing webApp is a catalogue bug, not a runtime condition — the
   * manifest carries every published hostname. Falling back to the bare name
   * yields an obviously-broken link rather than a crashed page.
   */
  base: (app: string) => string
  /**
   * The host as containers see it. Reaching the host from a rootless netns is
   * `host.containers.internal` and never the LAN IP, which under pasta refers
   * back to the container itself.
   */
  hc: string
}

export async function makeHosts(): Promise<Hosts> {
  const hosts = await webAppHosts()
  return {
    base: (app: string) => `https://${hosts[app] ?? app}`,
    hc: 'http://host.containers.internal',
  }
}
