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

export type Group = "catalog" | "beside" | "outside";

export interface Service {
  id: string;
  name: string;
  src: IconSource;
  group: Group;
  module?: string;
  /** passes through the middle of the frame first */
  focus?: true;
  hidden?: true;
}

const g =
  (group: Group) =>
  (id: string, name: string, src: IconSource, rest: Partial<Service> = {}): Service => ({ id, name, src, group, ...rest });
const cat = g("catalog");
const bes = g("beside");
const out = g("outside");

export const SERVICES: Service[] = [
  // — engine catalog, nix/modules/<id> (nix/README.md "The catalog") —
  cat("traefik", "Traefik", "app", { module: "traefik", focus: true }),
  cat("postgres", "PostgreSQL", "app", { module: "app-db", focus: true }),
  cat("pocket-id", "Pocket ID", "app", { module: "pocket-id", focus: true }),
  cat("prometheus", "Prometheus", "app", { module: "monitoring" }),
  cat("grafana", "Grafana", "app", { module: "monitoring", focus: true }),
  cat("pihole", "Pi-hole", "app", { module: "pihole" }),
  cat("zot", "zot", "app", { module: "registry" }),
  cat("loki", "Loki", "app", { module: "logging" }),
  cat("alloy", "Alloy", "di", { module: "logging" }),
  cat("verdaccio", "Verdaccio", "app", { module: "verdaccio" }),
  cat("gatus", "Gatus", "app", { module: "gatus" }),
  cat("healthchecks", "Healthchecks", "app", { module: "healthchecks" }),
  cat("wg-easy", "wg-easy", "sso", { module: "wg-easy" }),
  cat("factorio", "Factorio", "app", { module: "factorio" }),
  cat("grocy", "Grocy", "app", { module: "grocy" }),
  cat("metube", "MeTube", "app", { module: "metube" }),
  cat("myspeed", "MySpeed", "sso", { module: "myspeed" }),
  cat("stirling-pdf", "Stirling PDF", "app", { module: "stirling-pdf" }),
  cat("intel-gpu", "Intel GPU exporter", "si", { module: "intel-gpu-exporter" }),
  cat("apps", "Apps platform", "app", { module: "apps", hidden: true }),
  cat("cloudflared", "cloudflared", "app", { module: "cloudflared", hidden: true }),

  // — run on the reference box beside the engine: stacks/* in /etc/nixos, most read by an app page —
  bes("nextcloud", "Nextcloud", "app", { focus: true }),
  bes("immich", "Immich", "app"),
  bes("jellyfin", "Jellyfin", "app", { focus: true }),
  bes("home-assistant", "Home Assistant", "app"),
  bes("minecraft", "Minecraft", "app"),
  bes("sonarr", "Sonarr", "app"),
  bes("radarr", "Radarr", "app"),
  bes("prowlarr", "Prowlarr", "app"),
  bes("bazarr", "Bazarr", "app"),
  bes("qbittorrent", "qBittorrent", "app"),
  bes("nzbget", "NZBGet", "app"),
  bes("seerr", "Seerr", "app"),
  bes("calibre-web", "Calibre-Web", "app"),
  bes("shelfmark", "Shelfmark", "app"),
  bes("cleanuparr", "Cleanuparr", "app"),
  bes("janitorr", "Janitorr", "app"),
  bes("recyclarr", "Recyclarr", "app"),
  bes("n8n", "n8n", "app"),
  bes("open-webui", "Open WebUI", "app"),
  bes("litellm", "LiteLLM", "app"),
  bes("searxng", "SearXNG", "di"),
  bes("lemonade", "Lemonade", "app"),
  bes("wealthfolio", "Wealthfolio", "app"),
  bes("getbased", "getbased", "app"),
  bes("hermes-agent", "Hermes Agent", "app"),
  bes("gluetun", "Gluetun", "app"),

  // — outside services the control plane or the box's gateway talks to —
  out("cloudflare", "Cloudflare", "app", { focus: true }),
  out("github", "GitHub", "app", { focus: true }),
  out("github-actions", "GitHub Actions", "si"),
  out("vercel", "Vercel", "di"),
  out("letsencrypt", "Let's Encrypt", "di"),
  out("npm", "npm", "di"),
  out("claude-code", "Claude Code", "app"),
  out("protonvpn", "Proton VPN", "app"),
  out("ticktick", "TickTick", "si"),
  out("hevy", "Hevy", "app"),
  out("yazio", "Yazio", "app"),
];

/** What the field shows. */
export const SHOWN = SERVICES.filter((x) => !x.hidden);
