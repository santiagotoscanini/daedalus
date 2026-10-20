// Generates src/components/landing/app-icon-paths.ts: the app icons' computed geometry, written out
// once as literal strings so the component does no trigonometry at runtime (the prerender and the
// hydrated page must agree to the last digit). Run it by hand after changing a parameter here, in a
// throwaway container, and commit both files:
//
//   podman run --rm -v "$PWD":/w -w /w docker.io/library/node:24 node scripts/gen-icon-paths.mjs
//
// It has no dependencies. Every coordinate is on the icons' 1024 grid, rounded to one decimal.

import { writeFileSync } from "node:fs";

const { PI, sin, cos, abs, sign, pow, max, hypot } = Math;
/** One decimal, without a trailing .0 or a negative zero. */
const f1 = (n) => {
  const r = Math.round(n * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1).replace(/\.0$/, "");
};

// The squircle: a superellipse |x|^5 + |y|^5 = 1 on the 1024 square, Apple's icon outline to within
// a unit. Spec 1 sampled it every 2° as 180 straight segments (2.4 kB, and faceted at 256px); here
// each eighth of it is two cubic Béziers fitted to the true curve, so the outline is smooth at any
// size and the literal is a fifth as long. The fit's worst error is printed when this runs.
const N = 5;
const E = 2 / N;
const P = (t) => [512 + 512 * sign(cos(t)) * pow(abs(cos(t)), E), 512 + 512 * sign(sin(t)) * pow(abs(sin(t)), E)];
/** Unit tangent of the bottom-right quadrant at angle t (0 < t < π/2). */
function tangent(t) {
  const c = cos(t), s = sin(t);
  const dx = -512 * E * pow(c, E - 1) * s;
  const dy = 512 * E * pow(s, E - 1) * c;
  const l = hypot(dx, dy);
  return [dx / l, dy / l];
}
/** Distance (in units) from a point to the superellipse, from the implicit form. */
function off(x, y) {
  const u = (x - 512) / 512, v = (y - 512) / 512;
  const F = pow(abs(u), N) + pow(abs(v), N) - 1;
  const g = hypot(N * pow(abs(u), N - 1), N * pow(abs(v), N - 1));
  return (abs(F) / g) * 512;
}
const bez = (p0, p1, p2, p3, t) => {
  const m = 1 - t;
  return [0, 1].map((k) => m * m * m * p0[k] + 3 * m * m * t * p1[k] + 3 * m * t * t * p2[k] + t * t * t * p3[k]);
};
function fitSegment(t0, t1) {
  const p0 = P(t0), p3 = P(t1);
  // At t = 0 the tangent is exactly vertical (the flat side); the limit avoids 0^-0.6.
  const d0 = t0 === 0 ? [0, 1] : tangent(t0), d1 = tangent(t1);
  const chord = hypot(p3[0] - p0[0], p3[1] - p0[1]);
  let best = { err: Infinity };
  const tryAB = (a, b) => {
    const p1 = [p0[0] + d0[0] * a, p0[1] + d0[1] * a], p2 = [p3[0] - d1[0] * b, p3[1] - d1[1] * b];
    let err = 0;
    for (let i = 1; i < 64; i++) err = max(err, off(...bez(p0, p1, p2, p3, i / 64)));
    if (err < best.err) best = { err, a, b, p0, p1, p2, p3 };
  };
  for (let a = 0.05; a <= 0.7; a += 0.01) for (let b = 0.05; b <= 0.7; b += 0.01) tryAB(a * chord, b * chord);
  // refine around the coarse optimum
  for (let pass = 0; pass < 3; pass++) {
    const { a: a0, b: b0 } = best, step = chord * 0.01 * pow(0.2, pass);
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) tryAB(a0 + i * step, b0 + j * step);
  }
  return best;
}
function squircle() {
  // Split each eighth at the angle that minimises the worse of its two segments.
  let best = { err: Infinity };
  for (let deg = 4; deg <= 40; deg += 0.5) {
    const th = (deg * PI) / 180;
    const s1 = fitSegment(0, th), s2 = fitSegment(th, PI / 4);
    const err = max(s1.err, s2.err);
    if (err < best.err) best = { err, segs: [s1, s2], deg };
  }
  // One eighth (right side, going down to the diagonal), as cubic control points.
  const eighth = best.segs.map((s) => [s.p0, s.p1, s.p2, s.p3]);
  // Mirror across the diagonal for the second eighth (reversed), then rotate by 90° four times.
  const swap = ([x, y]) => [y, x];
  const quadrant = [...eighth, ...eighth.map((c) => c.map(swap).reverse()).reverse()];
  const rot = ([x, y]) => [1024 - y, x]; // 90° clockwise about the centre (y down)
  const quads = [quadrant];
  for (let q = 1; q < 4; q++) quads.push(quads[q - 1].map((c) => c.map(rot)));
  const segs = quads.flat();
  let d = `M${f1(segs[0][0][0])} ${f1(segs[0][0][1])}`;
  for (const [, p1, p2, p3] of segs) d += `C${f1(p1[0])} ${f1(p1[1])} ${f1(p2[0])} ${f1(p2[1])} ${f1(p3[0])} ${f1(p3[1])}`;
  return { d: `${d}Z`, err: best.err, deg: best.deg };
}

// Handwriting that is a gesture, never words. Spec 1's prolate cycloid, x = a·t − b·sin t and
// y = −h(1 − cos t)/2, drawn one hump at a time so each hump has its own width, height and loopiness.
// Spec 1 ran seven identical humps with the loops on the baseline, which reads as a row of arches
// ("mhh"), a doodle rather than a hand. Here the phase is turned half a cycle (x = a·t + b·sin t),
// so the loops sit at the top like a pen's: a hump with b > a closes into a loop (an l, or with a
// negative height a descender), one with b < a stays an open wave, and a gap splits the run into the
// two words of a title. None of it spells anything.
//   hump: [width, height, b/a]   gap: a number
function hand(x0, y0, slant, rise, humps) {
  const pts = [];
  let X = 0;
  for (const s of humps) {
    if (typeof s === "number") {
      X += s;
      pts.push(null); // pen up
      continue;
    }
    const [w, h, loop] = s;
    const a = w / (2 * PI), b = a * loop;
    for (let i = 0; i <= 240; i++) {
      const t = (i / 240) * 2 * PI;
      const y = (-h * (1 - cos(t))) / 2;
      const x = X + a * t + b * sin(t) - slant * y;
      pts.push([x0 + x, y0 + y - rise * x]);
    }
    X += w;
  }
  // Split at pen-ups, drop each run's repeated joints, then simplify (well under a pixel at 256).
  const runs = [[]];
  for (const p of pts) {
    if (!p) runs.push([]);
    else {
      const run = runs[runs.length - 1];
      const last = run[run.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) run.push(p);
    }
  }
  return runs
    .filter((r) => r.length > 1)
    .map((r) => simplify(r, 0.35).map((p, i) => `${i ? "L" : "M"}${f1(p[0])} ${f1(p[1])}`).join(""))
    .join("");
}
/** Ramer–Douglas–Peucker: keep only the points that bend the line by more than `tol` units. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const len = hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let worst = 0, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const dist = abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len;
    if (dist > worst) [worst, at] = [dist, i];
  }
  if (worst <= tol) return [a, b];
  return [...simplify(pts.slice(0, at + 1), tol).slice(0, -1), ...simplify(pts.slice(at), tol)];
}

// The Pinch title, two words: a capital loop, a wave, a small loop, a tall loop and a wave; then
// another capital, two waves, a small loop, a wave and a descender that dips through the red rule,
// the way a real card's does. The baseline climbs a little (rise), as a hand does across a card.
// The card's top edge is at y -202.8 and the pen is 14.3 wide, so the tallest stroke must top out
// at about -188 to keep a clear margin of paper above the ink: the capitals and the tall loop are
// drawn to that, and the small letters keep their height.
const PINCH = hand(-262, -124, 0.32, 0.025, [
  [58, 62, 1.3], [42, 28, 0.65], [40, 32, 1.6], [46, 56, 1.45], [42, 26, 0.7],
  36,
  [54, 52, 1.3], [38, 26, 0.65], [36, 28, 0.65], [38, 30, 1.6], [36, 26, 0.65], [42, -44, 1.4],
]);
/** The highest point of the hand's ink on the card, for the margin check printed below. */
const HAND_TOP = Math.min(...[...PINCH.matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1])));

// The Doorframe's height marks, on the face of the left casing (x 128 to 307.2, under the head that
// ends at y 256): [height, length]. Plain ticks, every one starting at x 148 and the same weight,
// long and short in turn like a ruler's. Initials written after them read as a smudge at any size
// the marks are drawn. Heights are multiples of 25.6 units, so a 1px line lands on whole device
// pixels at 20px and 40px on a 2x screen; they close up towards the top, as a child's growth slows.
const MARKS = [
  [358.4, 56],
  [460.8, 40],
  [563.2, 56],
  [691.2, 40],
];

const sq = squircle();
const ts = `// Generated by scripts/gen-icon-paths.mjs. Do not edit by hand: change the generator and rerun it.

/** The icon outline (superellipse n=5), shared by the clip, the edge light and the Home Screen tiles. */
export const SQUIRCLE =
  "${sq.d}";

/** The title on Grandma's card inside the Pinch icon, in the card's own frame (centre 0,0). */
export const PINCH_HAND =
  "${PINCH}";

/** The Doorframe's height marks: [height, length] of four plain ticks that start at the casing's left edge. */
export const DOOR_MARKS: readonly (readonly [number, number])[] = [
${MARKS.map(([y, len]) => `  [${y}, ${len}],`).join("\n")}
];
`;
writeFileSync(new URL("../src/components/landing/app-icon-paths.ts", import.meta.url), ts);
console.log(`squircle: 16 cubics, split at ${sq.deg}°, worst error ${sq.err.toFixed(3)} units; ${sq.d.length} chars`);
console.log(`PINCH_HAND: ${PINCH.length} chars, ink top at y ${HAND_TOP} (the card's top edge is -202.8)`);
