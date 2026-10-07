/** The labyrinth as a place: one list of numbers the 3D scene and the
 * poster both read, with no three.js in it so the first paint stays light.
 *
 * The walls are the mark's own stroke (labyrinth.tsx): one unbroken
 * axis-aligned line spiralling out from the centre, rings 8 units apart.
 * Every stroke segment is a wall; the 8-unit gap between two turns of it is
 * a corridor, and that corridor is one spiral that runs from the open
 * outside, the mouth, to a dead end at the heart. The centreline of that
 * corridor is the path the camera walks and the push travels.
 *
 * World units: the stroke's own units, centred on the stroke's start
 * (88, 88), so x is east, z is south and y is up. */

const STROKE =
  "M88 88 L88 96 L80 96 L80 80 L96 80 L96 104 L72 104 L72 72 L104 72 L104 112 " +
  "L64 112 L64 64 L112 64 L112 120 L56 120 L56 56 L120 56 L120 128 L48 128 " +
  "L48 48 L128 48 L128 136 L40 136 L40 40 L136 40 L136 144 L32 144 L32 32 " +
  "L144 32 L144 152 L24 152 L24 24 L152 24 L152 160 L16 160 L16 16 L160 16 " +
  "L160 168 L8 168 L8 8 L168 8";

export type V2 = readonly [number, number];

export const WALL_H = 11;
export const LANE = 8;

/** Stroke vertices, centre first, each with its share of the walk (0 at the
 * centre, 1 at the mouth end). */
export const WALLS: { x: number; z: number; along: number }[] = (() => {
  const n = STROKE.match(/-?\d+/g)!.map(Number);
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < n.length; i += 2) pts.push({ x: n[i]! - 88, z: n[i + 1]! - 88 });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  }
  const total = cum[cum.length - 1]!;
  return pts.map((p, i) => ({ ...p, along: cum[i]! / total }));
})();

/** The corridor's centreline, ordered from the heart outward. Each stroke
 * segment is offset half a lane to its outer (left-of-travel) side and the
 * offsets are mitred; the outer end runs on past the last wall to the open
 * ground, and the inner end ends at the dead end. */
export const LANE_PATH: { x: number; z: number; along: number }[] = (() => {
  const w = WALLS;
  const left = (a: (typeof w)[number], b: (typeof w)[number]): V2 => {
    const dx = Math.sign(b.x - a.x);
    const dz = Math.sign(b.z - a.z);
    // heading (dx, dz) on a y-down plan: its left is (dz, -dx)
    return [dz, -dx];
  };
  const h = LANE / 2;
  const out: { x: number; z: number; along: number }[] = [];
  for (let i = 0; i < w.length; i++) {
    const prev = i > 0 ? left(w[i - 1]!, w[i]!) : null;
    const next = i < w.length - 1 ? left(w[i]!, w[i + 1]!) : null;
    const a = prev ?? next!;
    const b = next ?? prev!;
    out.push({ x: w[i]!.x + (a[0] + b[0]) * h, z: w[i]!.z + (a[1] + b[1]) * h, along: w[i]!.along });
  }
  // the dead end sits short of the wall that closes it
  out.unshift({ x: out[0]!.x, z: out[0]!.z - 4, along: 0 });
  // the mouth: the corridor's open end, past the last wall
  const last = out[out.length - 1]!;
  out.push({ x: last.x + 46, z: last.z, along: 1 });
  return out;
})();

const cum = (() => {
  const c = [0];
  for (let i = 1; i < LANE_PATH.length; i++) {
    const a = LANE_PATH[i - 1]!;
    const b = LANE_PATH[i]!;
    c.push(c[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
  }
  return c;
})();
/** The corridor's length, heart to mouth, in world units. */
export const LANE_LENGTH = cum[cum.length - 1]!;

/** The point `d` units from the heart along the corridor. */
export function laneAt(d: number): { x: number; z: number; dx: number; dz: number } {
  const t = Math.min(LANE_LENGTH, Math.max(0, d));
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < t) i++;
  const a = LANE_PATH[i - 1]!;
  const b = LANE_PATH[i]!;
  const f = (t - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1);
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  return {
    x: a.x + (b.x - a.x) * f,
    z: a.z + (b.z - a.z) * f,
    dx: (b.x - a.x) / len,
    dz: (b.z - a.z) / len,
  };
}

/** The heart: where the box stands. */
export const BOX = { x: LANE_PATH[0]!.x, z: LANE_PATH[0]!.z - 1 } as const;
/** Where the corridor opens: the deploy leaves here. */
export const MOUTH = { x: LANE_PATH[LANE_PATH.length - 2]!.x, z: LANE_PATH[LANE_PATH.length - 2]!.z } as const;

/** The two machines linked over TLS, and the apps' ring. Positions are the
 * composition's, not a map of anything. */
export const MACHINES = [
  { id: "mac", label: "Mac", x: -132, y: 30, z: 24, w: 32, h: 20, d: 1.6 },
  { id: "pc", label: "PC", x: -46, y: 32, z: -158, w: 16, h: 32, d: 28 },
] as const;

/** The apps on the ring. The names are fixture names of the demo window; the
 * one a deploy lands on is `LANDING`. */
export const APPS = ["anansi", "argus", "chismed", "hermes", "iris", "lintel", "voyra", "plutus"] as const;
export const LANDING = 5;
export const RING_R = 138;
export function appPos(i: number): { x: number; z: number } {
  const a = (i / APPS.length) * Math.PI * 2 + (Math.PI * 130) / 180;
  return { x: Math.cos(a) * RING_R, z: Math.sin(a) * RING_R };
}

/** The corridor point whose share of the walk is `a` (0 heart, 1 mouth). */
export function laneAtAlong(a: number): { x: number; z: number } {
  const t = Math.min(1, Math.max(0, a));
  for (let i = 1; i < LANE_PATH.length; i++) {
    const p = LANE_PATH[i - 1]!;
    const q = LANE_PATH[i]!;
    if (t <= q.along && q.along > p.along) {
      const f = (t - p.along) / (q.along - p.along);
      return { x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f };
    }
  }
  const last = LANE_PATH[LANE_PATH.length - 1]!;
  return { x: last.x, z: last.z };
}

/** The share of the walk (0 heart, 1 mouth) of the corridor point `d` units from the heart. */
export function laneAlongAt(d: number): number {
  const t = Math.min(LANE_LENGTH, Math.max(0, d));
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < t) i++;
  const a = LANE_PATH[i - 1]!;
  const b = LANE_PATH[i]!;
  const f = (t - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1);
  return a.along + (b.along - a.along) * f;
}
