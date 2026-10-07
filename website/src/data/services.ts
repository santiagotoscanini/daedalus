import type { MarkId } from "~/components/walk/marks";
import type { BrandId } from "./brand-marks";

/** The services universe: every name the landing's field shows, its tier, and
 * the one line of evidence it stands on. This file is the only place a tier is
 * decided, and flipping an item's tier here is how it graduates (a "beside"
 * service that becomes a catalog module gets `tier: "catalog"` and its
 * `module` id; vite.config.ts then checks the id against nix/modules).
 *
 * Three tiers, each a claim the engine repo or the reference host can back:
 *
 *  - catalog   a module under nix/modules/<id>, off until a host switches it on.
 *  - beside    runs on a Daedalus box (or on a machine its agent manages) and
 *              gets a hostname, a certificate and image updates from the
 *              platform, but is not a catalog module yet.
 *  - connects  an outside service Daedalus talks to.
 *
 * Counts printed on the page are computed from these arrays; nothing is
 * typed in twice. A catalog tile carries `module`; several tiles may share
 * one module (monitoring is Prometheus and Grafana). A service with no mark
 * in simple-icons has `mono`, a two-letter monogram, not an invented logo.
 * The marks are trademarks of their owners and appear only to say which
 * service is meant. */

export type Tier = "catalog" | "beside" | "connects";

export interface Service {
  id: string;
  name: string;
  tier: Tier;
  /** a brand mark by id; `daedalus` is this product's own */
  mark?: BrandId | MarkId | "daedalus";
  /** the monogram for a service with no mark */
  mono?: string;
  /** catalog tiles: the module's directory under nix/modules */
  module?: string;
  /** shown on a phone, where the field is thinned */
  lead?: true;
}

export const TIERS: Record<Tier, { label: string; line: string }> = {
  catalog: {
    label: "In the catalog",
    line: "Modules in the engine. Each is off until a host switches it on.",
  },
  beside: {
    label: "Managed beside it",
    line: "Run on a Daedalus box and given a hostname, a certificate and image updates by the platform. Not in the public catalog yet.",
  },
  connects: {
    label: "Connects to",
    line: "Outside services it talks to: DNS and tunnels, source hosting, certificates, and the apps reached through its gateway.",
  },
};

export const SERVICES: Service[] = [
  // — in the catalog: nix/modules/*, listed in nix/README.md "The catalog" —
  { id: "traefik", name: "Traefik", tier: "catalog", mark: "traefikproxy", module: "traefik", lead: true },
  { id: "postgres", name: "PostgreSQL", tier: "catalog", mark: "postgresql", module: "app-db", lead: true },
  { id: "pocket-id", name: "Pocket ID", tier: "catalog", mono: "Id", module: "pocket-id", lead: true },
  { id: "prometheus", name: "Prometheus", tier: "catalog", mark: "prometheus", module: "monitoring", lead: true },
  { id: "grafana", name: "Grafana", tier: "catalog", mark: "grafana", module: "monitoring", lead: true },
  { id: "pihole", name: "Pi-hole", tier: "catalog", mark: "pihole", module: "pihole", lead: true },
  { id: "cloudflared", name: "cloudflared", tier: "catalog", mono: "cf", module: "cloudflared" },
  { id: "apps", name: "Apps platform", tier: "catalog", mark: "daedalus", module: "apps", lead: true },
  { id: "zot", name: "zot", tier: "catalog", mono: "zo", module: "registry" },
  { id: "loki", name: "Loki", tier: "catalog", mono: "Lk", module: "logging" },
  { id: "alloy", name: "Alloy", tier: "catalog", mono: "Al", module: "logging" },
  { id: "verdaccio", name: "Verdaccio", tier: "catalog", mark: "verdaccio", module: "verdaccio" },
  { id: "gatus", name: "Gatus", tier: "catalog", mono: "Ga", module: "gatus" },
  { id: "healthchecks", name: "Healthchecks", tier: "catalog", mono: "Hc", module: "healthchecks" },
  { id: "wg-easy", name: "wg-easy", tier: "catalog", mark: "wireguard", module: "wg-easy" },
  { id: "factorio", name: "Factorio", tier: "catalog", mono: "Fa", module: "factorio", lead: true },
  { id: "grocy", name: "Grocy", tier: "catalog", mark: "grocy", module: "grocy" },
  { id: "metube", name: "MeTube", tier: "catalog", mono: "Me", module: "metube" },
  { id: "myspeed", name: "MySpeed", tier: "catalog", mono: "My", module: "myspeed" },
  { id: "stirling-pdf", name: "Stirling PDF", tier: "catalog", mono: "St", module: "stirling-pdf" },
  { id: "intel-gpu", name: "Intel GPU", tier: "catalog", mark: "intel", module: "intel-gpu-exporter" },

  // — managed beside it: stacks on the reference box (its stacks/ directory), most read by a
  //   page of the app (Media, Home, Gaming, AI, Health) —
  { id: "nextcloud", name: "Nextcloud", tier: "beside", mark: "nextcloud", lead: true },
  { id: "immich", name: "Immich", tier: "beside", mark: "immich", lead: true },
  { id: "jellyfin", name: "Jellyfin", tier: "beside", mark: "jellyfin", lead: true },
  { id: "home-assistant", name: "Home Assistant", tier: "beside", mark: "homeassistant", lead: true },
  { id: "minecraft", name: "Minecraft", tier: "beside", mono: "Mc", lead: true },
  { id: "sonarr", name: "Sonarr", tier: "beside", mark: "sonarr", lead: true },
  { id: "radarr", name: "Radarr", tier: "beside", mark: "radarr", lead: true },
  { id: "prowlarr", name: "Prowlarr", tier: "beside", mono: "Pr" },
  { id: "bazarr", name: "Bazarr", tier: "beside", mono: "Bz" },
  { id: "qbittorrent", name: "qBittorrent", tier: "beside", mark: "qbittorrent" },
  { id: "nzbget", name: "NZBGet", tier: "beside", mono: "Nz" },
  { id: "seerr", name: "Seerr", tier: "beside", mono: "Se" },
  { id: "calibre-web", name: "Calibre-Web", tier: "beside", mark: "calibreweb" },
  { id: "shelfmark", name: "Shelfmark", tier: "beside", mono: "Sh" },
  { id: "cleanuparr", name: "Cleanuparr", tier: "beside", mono: "Cl" },
  { id: "janitorr", name: "Janitorr", tier: "beside", mono: "Ja" },
  { id: "recyclarr", name: "Recyclarr", tier: "beside", mono: "Rc" },
  { id: "n8n", name: "n8n", tier: "beside", mark: "n8n", lead: true },
  { id: "open-webui", name: "Open WebUI", tier: "beside", mono: "Ow", lead: true },
  { id: "litellm", name: "LiteLLM", tier: "beside", mono: "Ll" },
  { id: "searxng", name: "SearXNG", tier: "beside", mark: "searxng" },
  { id: "lemonade", name: "Lemonade", tier: "beside", mono: "Lm" },
  { id: "wealthfolio", name: "Wealthfolio", tier: "beside", mono: "Wf" },
  { id: "getbased", name: "getbased", tier: "beside", mono: "Gb" },
  { id: "gluetun", name: "Gluetun", tier: "beside", mono: "Gl" },

  // — connects to: services Daedalus calls, from app/src and the reference host's gateway —
  { id: "cloudflare", name: "Cloudflare", tier: "connects", mark: "cloudflare", lead: true },
  { id: "github", name: "GitHub", tier: "connects", mark: "github", lead: true },
  { id: "github-actions", name: "GitHub Actions", tier: "connects", mark: "githubactions", lead: true },
  { id: "github-pages", name: "GitHub Pages", tier: "connects", mono: "Pg" },
  { id: "vercel", name: "Vercel", tier: "connects", mark: "vercel", lead: true },
  { id: "letsencrypt", name: "Let's Encrypt", tier: "connects", mark: "letsencrypt" },
  { id: "npm", name: "npm", tier: "connects", mark: "npm" },
  { id: "claude-code", name: "Claude Code", tier: "connects", mark: "claude", lead: true },
  { id: "mojang", name: "Mojang", tier: "connects", mono: "Mj" },
  { id: "protonvpn", name: "Proton VPN", tier: "connects", mark: "protonvpn" },
  { id: "ticktick", name: "TickTick", tier: "connects", mark: "ticktick", lead: true },
  { id: "hevy", name: "Hevy", tier: "connects", mark: "hevy", lead: true },
  { id: "yazio", name: "Yazio", tier: "connects", mono: "Yz" },
];

export const byTier = (t: Tier) => SERVICES.filter((s) => s.tier === t);

/** The numbers the page prints, computed from the list above. */
export const COUNTS = {
  catalogModules: new Set(SERVICES.filter((s) => s.module).map((s) => s.module)).size,
  catalog: byTier("catalog").length,
  beside: byTier("beside").length,
  connects: byTier("connects").length,
  total: SERVICES.length,
};
