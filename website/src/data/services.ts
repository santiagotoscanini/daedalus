/** Everything the landing's field shows: the hosted apps and integrations, one list, no tiers.
 *
 * An entry means the engine or the reference box really runs or reaches it. The evidence for each
 * group is noted for maintainers and never shown to visitors. Add or remove a service by editing
 * this file; nothing on the page prints a count. Each entry carries the official mark vendored under
 * src/assets/icons/<id>.<ext> and where that file came from (`src`), which is also the credits table:
 *
 *   app   the engine's own app/public/icon-<x> (the mark the control plane shows for the service)
 *   di    homarr-labs/dashboard-icons (Apache-2.0; the marks belong to their owners)
 *   si    simple-icons (CC0; the marks belong to their owners), filled in the brand colour
 *   sso   the reference host's SSO logo set (the service's own logo)
 *
 * Marks are trademarks of their owners and appear only to say which service is meant. A service with
 * no official mark found is left out (Mojang, GitHub Pages), never given a monogram.
 *
 * `module` is a catalog module id under nix/modules; the site build fails if a module directory has no
 * entry here or an entry names one that does not exist. `hidden` keeps a module covered without a tile
 * (the apps platform and cloudflared have no mark of their own apart from Daedalus and Cloudflare). */

export type IconSource = "app" | "di" | "si" | "sso";

export interface Service {
  id: string;
  name: string;
  src: IconSource;
  module?: string;
  /** passes through the middle of the frame first */
  focus?: true;
  hidden?: true;
}

const s = (id: string, name: string, src: IconSource, rest: Partial<Service> = {}): Service => ({ id, name, src, ...rest });

export const SERVICES: Service[] = [
  // — engine catalog, nix/modules/<id> (nix/README.md "The catalog") —
  s("traefik", "Traefik", "app", { module: "traefik", focus: true }),
  s("postgres", "PostgreSQL", "app", { module: "app-db", focus: true }),
  s("pocket-id", "Pocket ID", "app", { module: "pocket-id", focus: true }),
  s("prometheus", "Prometheus", "app", { module: "monitoring" }),
  s("grafana", "Grafana", "app", { module: "monitoring", focus: true }),
  s("pihole", "Pi-hole", "app", { module: "pihole" }),
  s("zot", "zot", "app", { module: "registry" }),
  s("loki", "Loki", "app", { module: "logging" }),
  s("alloy", "Alloy", "di", { module: "logging" }),
  s("verdaccio", "Verdaccio", "app", { module: "verdaccio" }),
  s("gatus", "Gatus", "app", { module: "gatus" }),
  s("healthchecks", "Healthchecks", "app", { module: "healthchecks" }),
  s("wg-easy", "wg-easy", "sso", { module: "wg-easy" }),
  s("factorio", "Factorio", "app", { module: "factorio" }),
  s("grocy", "Grocy", "app", { module: "grocy" }),
  s("metube", "MeTube", "app", { module: "metube" }),
  s("myspeed", "MySpeed", "sso", { module: "myspeed" }),
  s("stirling-pdf", "Stirling PDF", "app", { module: "stirling-pdf" }),
  s("intel-gpu", "Intel GPU exporter", "si", { module: "intel-gpu-exporter" }),
  s("apps", "Apps platform", "app", { module: "apps", hidden: true }),
  s("cloudflared", "cloudflared", "app", { module: "cloudflared", hidden: true }),

  // — run on the reference box beside the engine: stacks/* in /etc/nixos, most read by an app page —
  s("nextcloud", "Nextcloud", "app", { focus: true }),
  s("immich", "Immich", "app"),
  s("jellyfin", "Jellyfin", "app", { focus: true }),
  s("home-assistant", "Home Assistant", "app"),
  s("minecraft", "Minecraft", "app"),
  s("sonarr", "Sonarr", "app"),
  s("radarr", "Radarr", "app"),
  s("prowlarr", "Prowlarr", "app"),
  s("bazarr", "Bazarr", "app"),
  s("qbittorrent", "qBittorrent", "app"),
  s("nzbget", "NZBGet", "app"),
  s("seerr", "Seerr", "app"),
  s("calibre-web", "Calibre-Web", "app"),
  s("shelfmark", "Shelfmark", "app"),
  s("cleanuparr", "Cleanuparr", "app"),
  s("janitorr", "Janitorr", "app"),
  s("recyclarr", "Recyclarr", "app"),
  s("n8n", "n8n", "app"),
  s("open-webui", "Open WebUI", "app"),
  s("litellm", "LiteLLM", "app"),
  s("searxng", "SearXNG", "di"),
  s("lemonade", "Lemonade", "app"),
  s("wealthfolio", "Wealthfolio", "app"),
  s("getbased", "getbased", "app"),
  s("hermes-agent", "Hermes Agent", "app"),
  s("gluetun", "Gluetun", "app"),

  // — outside services the control plane or the box's gateway talks to —
  s("cloudflare", "Cloudflare", "app", { focus: true }),
  s("github", "GitHub", "app", { focus: true }),
  s("github-actions", "GitHub Actions", "si"),
  s("vercel", "Vercel", "di"),
  s("letsencrypt", "Let's Encrypt", "di"),
  s("npm", "npm", "di"),
  s("claude-code", "Claude Code", "app"),
  s("protonvpn", "Proton VPN", "app"),
  s("ticktick", "TickTick", "si"),
  s("hevy", "Hevy", "app"),
  s("yazio", "Yazio", "app"),
];

/** What the field shows. */
export const SHOWN = SERVICES.filter((x) => !x.hidden);
