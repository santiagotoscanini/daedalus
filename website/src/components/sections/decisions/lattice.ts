/** The tree's geometry, ported from the manifesto's FIG. 1 (personal-portfolio, manifesto/lattice.ts).
 *
 * Every question is a column of options, and every option joins every option of the next column,
 * so the drawing is all the ways an app could be built: 4·4·4·3·3·3·3·3·3 = 46,656 of them. A cut
 * collapses a column to the one answer kept. Wide, the gap a column opens on the axis shrinks with
 * it, on a fixed scale that is never renormalised, so the end of the line travels toward the
 * request as the cuts land and a dashed ghost keeps the length it used to be.
 *
 * Station 0 is your request, 1..9 are the questions, 10 is your app. Wide, the axis runs left to
 * right on y 350 from x 60 (880 units open, so one gap unit is 93.62 and the stations sit at 60,
 * 125.5, 219.2 … 874.5, end 940; after the seven house cuts the end is at 546.8, after the request's
 * two at 434.5). Narrow, it runs down x 32.5 from y 12.3, 46 to the unit, and it holds its length:
 * a cut only folds the column's fan into the axis, so each station stays level with its row of
 * answers and every leader stays a short straight line (`still`). There the end sits a whole unit
 * after the last question (458.5), so its label is a tenth row in the rows' rhythm. `frame()` rounds
 * every coordinate to 0.1, so the prerender and the browser write the same numbers. */

import { COLUMNS } from "./requests";

/** Options per station: the request, the nine questions, the app. */
export const COUNTS: readonly number[] = [1, ...COLUMNS.map((c) => c.n), 1];
export const STATIONS = COUNTS.length;
const LAST = STATIONS - 1;

/** Axis length in gap units with every option open: two half-gaps at the ends, eight full ones. */
const FULL = 9.4;

export type Orient = {
  /** Axis coordinate of the request. */
  axis0: number;
  /** Cross coordinate of the axis. */
  cross: number;
  /** Axis length the fully open drawing spans. */
  L: number;
  /** Distance between neighbouring options of one column. */
  pitch: number;
  vertical: boolean;
  /** The stations keep their open places through every cut. */
  still?: boolean;
};

export const WIDE: Orient = { axis0: 60, cross: 350, L: 880, pitch: 40, vertical: false };
/** 12.3 + 46 × 0.7 puts station 1 on y 44.5, and every station after it on a half pixel too, so the
 * leaders level with them are crisp hairlines. */
export const NARROW: Orient = { axis0: 12.3, cross: 32.5, L: 432.4, pitch: 14, vertical: true, still: true };

/** The fixed topology every frame is laid onto: 32 nodes and 96 edges. */
export const NODES: readonly { station: number; j: number }[] = COUNTS.flatMap((n, station) =>
  Array.from({ length: n }, (_, j) => ({ station, j })),
);

const FIRST = COUNTS.map((_, i) => COUNTS.slice(0, i).reduce((a, b) => a + b, 0));

/** Index of option j of station st in NODES. */
export const nodeAt = (st: number, j: number) => FIRST[st]! + j;

export const EDGES: readonly { a: number; b: number }[] = COUNTS.slice(0, -1).flatMap((n, s) =>
  Array.from({ length: n * COUNTS[s + 1]! }, (_, k) => ({
    a: FIRST[s]! + Math.floor(k / COUNTS[s + 1]!),
    b: FIRST[s + 1]! + (k % COUNTS[s + 1]!),
  })),
);

export const r1 = (v: number) => Math.round(v * 10) / 10;

export type Frame = {
  /** Each station's centre on the axis: [x, y]. */
  stations: [number, number][];
  nodes: { x: number; y: number; alpha: number }[];
  end: [number, number];
  /** Where the end sat with every option open: the ghost's far end. */
  ghost: [number, number];
};

/** `t[c]` is column c's eased cut (0 open, 1 settled) and `keep[c]` the option it keeps. */
export function frame(t: readonly number[], keep: readonly number[], o: Orient): Frame {
  const open = COUNTS.map((_, i) => (i === 0 || i === LAST ? 0 : 1 - (t[i - 1] ?? 0)));
  const gap = (i: number) => (o.still ? 1 : 0.4 + (0.6 * (open[i - 1]! + open[i]!)) / 2);
  const unit = o.L / FULL;
  const s = [0];
  // still: the open spacing for good (a short gap from the request, a whole one between questions
  // and on to the end)
  for (let i = 1; i < STATIONS; i++) s.push(s[i - 1]! + (o.still && i === 1 ? 0.7 : gap(i)));
  const at = (axis: number, cross: number): [number, number] =>
    o.vertical ? [r1(o.cross + cross), r1(o.axis0 + axis * unit)] : [r1(o.axis0 + axis * unit), r1(o.cross + cross)];

  const nodes = NODES.map(({ station, j }) => {
    const n = COUNTS[station]!;
    let off = (j - (n - 1) / 2) * o.pitch;
    let alpha = 1;
    if (station > 0 && station < LAST) {
      const ti = t[station - 1] ?? 0;
      if (j === keep[station - 1]) off *= 1 - ti;
      else alpha = 1 - 0.82 * ti;
    }
    const [x, y] = at(s[station]!, off);
    return { x, y, alpha: Math.round(alpha * 100) / 100 };
  });

  return { stations: s.map((v) => at(v, 0)), nodes, end: at(s[LAST]!, 0), ghost: at(FULL, 0) };
}

/** Ways to build it, with a column counted as settled from its cut's midpoint: the count only ever shows
 * a number the drawing holds (46,656, 11,664 … 9, 3, 1), stepping once per cut. */
export function paths(t: readonly number[]): number {
  return COUNTS.slice(1, -1).reduce((p, n, c) => p * ((t[c] ?? 0) >= 0.5 ? 1 : n), 1);
}

/** 1, 4, 16 … 46,656: the ways counted once the walk has reached station st. */
export const RUNNING: readonly number[] = COUNTS.map((_, st) => COUNTS.slice(0, st + 1).reduce((a, b) => a * b, 1));

export const ALL_OPEN: readonly number[] = COLUMNS.map(() => 0);
export const ALL_CUT: readonly number[] = COLUMNS.map(() => 1);
