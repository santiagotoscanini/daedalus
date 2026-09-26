import { webAppHosts } from './nix-manifest'

// Where a dashboard loader dials, and nothing else: two strings' worth of
// addressing, read from the nix manifest. Loaders receive it as `ctx.hosts`
// (core/ctx.ts builds the `Ctx` with this).

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
