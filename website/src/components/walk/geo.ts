/** The network as a place: positions and facts the scene and the page both read, with no three.js in it so the first paint stays light.

World units on a ground plane, y up. The box sits at the middle with the
mark's labyrinth as its body; the machines and the outside world stand
around it, each joined to it by one link. */

const STROKE =
  "M88 88 L88 96 L80 96 L80 80 L96 80 L96 104 L72 104 L72 72 L104 72 L104 112 " +
  "L64 112 L64 64 L112 64 L112 120 L56 120 L56 56 L120 56 L120 128 L48 128 " +
  "L48 48 L128 48 L128 136 L40 136 L40 40 L136 40 L136 144 L32 144 L32 32 " +
  "L144 32 L144 152 L24 152 L24 24 L152 24 L152 160 L16 160 L16 16 L160 16 " +
  "L160 168 L8 168 L8 8 L168 8";

export type V2 = readonly [number, number];

export const WALL_H = 11;

/** The mark's stroke, centre first, centred on its own start. */
export const WALLS: { x: number; z: number }[] = (() => {
  const n = STROKE.match(/-?\d+/g)!.map(Number);
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < n.length; i += 2) pts.push({ x: n[i]! - 88, z: n[i + 1]! - 88 });
  return pts;
})();

export type NodeId = "box" | "mac" | "pc" | "pc2" | "github" | "net";

/** Where each stands, and the line the page prints beside it. */
export const NODES: Record<NodeId, { x: number; z: number; name: string; state: string }> = {
  box: { x: 0, z: 0, name: "the box", state: "NixOS · controller" },
  mac: { x: -182, z: -22, name: "MacBook Pro", state: "approved · pinned key" },
  pc: { x: 168, z: 50, name: "Windows PC", state: "GPU · model server" },
  pc2: { x: 120, z: -112, name: "Windows PC 2", state: "approved · pinned key" },
  github: { x: -58, z: -152, name: "GitHub", state: "the App · webhook" },
  net: { x: 4, z: 176, name: "the internet", state: "a client" },
};
export const BOX_AT = NODES.box;

/** The machines linked over pinned TLS (the agent's one outbound connection each). */
export const MACHINES = ["mac", "pc", "pc2"] as const;

export interface LinkSpec {
  id: string;
  a: NodeId;
  b: NodeId;
  /** how high the arc rises between its ends */
  rise: number;
  /** a sideways bow, to keep two links apart */
  bow: number;
}
export const LINKS: LinkSpec[] = [
  { id: "mac", a: "box", b: "mac", rise: 26, bow: 0 },
  { id: "pc", a: "box", b: "pc", rise: 26, bow: 0 },
  { id: "pc2", a: "box", b: "pc2", rise: 26, bow: 0 },
  { id: "github", a: "github", b: "box", rise: 22, bow: 0 },
  { id: "net", a: "net", b: "box", rise: 18, bow: 0 },
];

/** The apps on the ring round the box; a deploy lands on LANDING. Names are the demo window's own fixtures. */
export const APPS = ["anansi", "argus", "chismed", "hermes", "iris", "lintel", "voyra", "plutus"] as const;
export const LANDING = 5;
export const RING_R = 84;
export function appPos(i: number): { x: number; z: number } {
  const a = (i / APPS.length) * Math.PI * 2 + 0.25;
  return { x: Math.cos(a) * RING_R, z: Math.sin(a) * RING_R };
}

/** The services the box takes in, each with what it replaces and what lights. The pairs are the catalog's own. */
export const INGEST: Array<{ name: string; part: string; module: string; made: string }> = [
  { name: "Vercel", part: "push-to-deploy", module: "apps · builds", made: "Builds and deploys your repo, on the box." },
  { name: "Auth0", part: "single sign-on", module: "pocket-id", made: "One identity provider, one account." },
  { name: "Datadog", part: "metrics, logs, alerts", module: "monitoring · logging", made: "Prometheus, Grafana and Loki." },
  { name: "Docker Hub", part: "the image registry", module: "registry", made: "The box's own OCI registry." },
  { name: "AWS RDS", part: "managed Postgres", module: "app-db", made: "One cluster, a role and database per app." },
  { name: "Route 53 + ACM", part: "DNS and certificates", module: "traefik · cloudflared", made: "A wildcard certificate and a tunnel." },
];
export const PORT_R = 176;
export const MODULE_R = 66;
export function portAngle(i: number): number {
  return (i / INGEST.length) * Math.PI * 2 + Math.PI / 6;
}
