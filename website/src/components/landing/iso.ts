/** The landing's isometric drawing kit, shared by the kitchen and the move to Vercel, so both figures
 * are one illustration style: true isometric (30°), objects built from boxes, each box drawn as its
 * three visible faces in three tones of the page's grey (lit from the upper left: top lightest, the
 * face toward the viewer's left in the middle, the face toward the right darkest) with one hairline
 * edge colour. Scenes are written in plain units (about 10cm each) and projected here; every number
 * the SVG receives is rounded to a tenth, so the prerender and the hydrated page agree exactly.
 *
 * Axes: x runs to the lower right, y to the lower left, z up. The viewer stands at +x +y, so a box
 * shows its top, its +y face (on the left) and its +x face (on the right). */

export type V3 = readonly [number, number, number];
type P2 = readonly [number, number];

/** Pixels per unit at 1:1. */
export const K = 6.4;
const C = Math.cos(Math.PI / 6);

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A point in space, on the page. */
export function pt(x: number, y: number, z: number): P2 {
  return [r1((x - y) * C * K), r1(((x + y) / 2 - z) * K)];
}

const fmt = ([x, y]: P2) => `${x} ${y}`;

/** A closed polygon through points in space. */
export function poly(points: readonly V3[]): string {
  return `M${points.map((p) => fmt(pt(...p))).join("L")}Z`;
}

/** An open polyline through points in space. */
export function line(points: readonly V3[]): string {
  return `M${points.map((p) => fmt(pt(...p))).join("L")}`;
}

export interface Faces {
  top: string;
  left: string;
  right: string;
}

/** A box from its near-origin corner and its size along x, y and z: its three visible faces. */
export function box(x: number, y: number, z: number, w: number, d: number, h: number): Faces {
  return {
    top: poly([
      [x, y, z + h],
      [x + w, y, z + h],
      [x + w, y + d, z + h],
      [x, y + d, z + h],
    ]),
    left: poly([
      [x, y + d, z],
      [x + w, y + d, z],
      [x + w, y + d, z + h],
      [x, y + d, z + h],
    ]),
    right: poly([
      [x + w, y, z],
      [x + w, y + d, z],
      [x + w, y + d, z + h],
      [x + w, y, z + h],
    ]),
  };
}

/** A rectangle lying on a face: on the +y face at depth `y` (spanning x and z), or on the +x face at
 * `x` (spanning y and z), or flat at height `z` (spanning x and y). */
export function onY(y: number, x0: number, x1: number, z0: number, z1: number): string {
  return poly([
    [x0, y, z0],
    [x1, y, z0],
    [x1, y, z1],
    [x0, y, z1],
  ]);
}
export function onX(x: number, y0: number, y1: number, z0: number, z1: number): string {
  return poly([
    [x, y0, z0],
    [x, y1, z0],
    [x, y1, z1],
    [x, y0, z1],
  ]);
}
export function onZ(z: number, x0: number, x1: number, y0: number, y1: number): string {
  return poly([
    [x0, y0, z],
    [x1, y0, z],
    [x1, y1, z],
    [x0, y1, z],
  ]);
}

/** A circle drawn on a plane, as the ellipse it projects to (48 points): on the +x face ("x"), the +y
 * face ("y") or flat ("z"). */
export function circle(plane: "x" | "y" | "z", c: V3, r: number): string {
  const pts: V3[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const u = Math.cos(a) * r;
    const v = Math.sin(a) * r;
    pts.push(
      plane === "x" ? [c[0], c[1] + u, c[2] + v] : plane === "y" ? [c[0] + u, c[1], c[2] + v] : [c[0] + u, c[1] + v, c[2]],
    );
  }
  return poly(pts);
}

/** A quadratic arc from `a` to `b`, lifted at its middle by `lift` units: a projected quadratic is a
 * quadratic, so the page draws it exactly. */
export function arc(a: V3, b: V3, lift: number): string {
  const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + lift * 2];
  return `M${fmt(pt(...a))}Q${fmt(pt(...m))} ${fmt(pt(...b))}`;
}

/** The same arc as a function of t (0 to 1), on the page: for the move's flight. */
export function arcAt(a: V3, b: V3, lift: number, t: number): P2 {
  const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 + lift * 2];
  const q = (i: 0 | 1 | 2) => (1 - t) ** 2 * a[i] + 2 * (1 - t) * t * m[i] + t ** 2 * b[i];
  return pt(q(0), q(1), q(2));
}

/** The page box around a set of points in space, padded, as x y w h. */
export function bounds(points: readonly V3[], pad: number): readonly [number, number, number, number] {
  const p = points.map((q) => pt(...q));
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return [r1(x), r1(y), r1(Math.max(...xs) + pad - x), r1(Math.max(...ys) + pad - y)];
}

/** Every corner of a box, for `bounds`. */
export function corners(x: number, y: number, z: number, w: number, d: number, h: number): V3[] {
  const out: V3[] = [];
  for (const a of [x, x + w]) for (const b of [y, y + d]) for (const c of [z, z + h]) out.push([a, b, c]);
  return out;
}
