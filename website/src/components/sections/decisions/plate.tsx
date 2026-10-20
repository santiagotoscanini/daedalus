/** The tree, wide (containers 920px and up): the manifesto's FIG. 1 turned to the house. A request
 * sits at the top of the plate and drops into the tree's start; every question an app has to answer
 * is a column of options, so the drawing holds every way the app could be built. The house cuts
 * seven columns the same way for every app, the request settles the last two, and the green path
 * is what is left: one way, from your request to your app. Each cut hands its question to a row of
 * the callout stack beside it, on an elbow leader, so the answers read as a list at a glance: the
 * question leaves first and the leader and the row follow, so a leader never runs through words.
 * While the cuts land a dashed ghost keeps the length the line used to be; the app's icon replaces
 * it at the end, so the finished frame has no tail. What runs the answer under the pointer prints
 * in the band under the ninth row ("Under the hood").
 *
 * This file also holds what both compositions share: the run (a pure function of time), and the
 * writer that paints it. The prerender is the finished frame for Pinch, so no-JS, reduced motion
 * and a reader who arrives on it see the whole argument at once. Everything that moves is written
 * by one rAF loop (decisions.tsx) straight to the DOM through attributes, skipping values it already
 * wrote, so React never renders a frame of it.
 *
 * The wide plate is one picture: its geometry is in viewBox units and its HTML overlay is laid out
 * in the same units (`--u`, a thousandth of the plate's width), so between 920 and 1000px the whole
 * drawing, type included, scales as one. */

import { type CSSProperties, memo } from "react";

import { AppIcon } from "~/components/landing/app-icon";
import { EASE } from "~/components/landing/motion";
import { Replay } from "~/components/icons";

import {
  ALL_CUT,
  ALL_OPEN,
  COUNTS,
  EDGES,
  NODES,
  RUNNING,
  STATIONS,
  WIDE,
  frame,
  nodeAt,
  paths,
  r1,
  type Frame,
} from "./lattice";
import { COLUMNS, HOUSE_KEEP, REQUESTS, SEGMENTS, WHERE, WHO, fmt } from "./requests";

/* ------------------------------------------------------------------ *
 * The run. Times are ms from the moment the plate plays.
 * ------------------------------------------------------------------ */

const OUT = EASE.out;
const INOUT = EASE.inout;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Before the run the drawing stands faintly (questions, nodes, the ends, no edges), so the plate
 * never reads as an empty box. */
const SKETCH = 0.18;
const sk = (v: number) => SKETCH + (1 - SKETCH) * v;
/* The sketch holds no answers. Every row arrives from nothing at its own cut, so each question is
 * printed once (over its open column until the cut hands it to its row) and each answer is read
 * first where the cut gives it. */
const ease = (ms: number, at: number, len: number, f = OUT) => f(clamp01((ms - at) / len));

/** Walk: the edges leaving station st start growing at WALK_AT[st] and take 300ms. */
const WALK_AT = COUNTS.slice(1).map((_, st) => 60 + 70 * st);
const WALK_LEN = 300;
/** Where the walk's eased edge passes 0.8: the moment the station it reaches lights. */
const X08 = (() => {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (OUT(mid) < 0.8) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
})();
const LIT_AT = WALK_AT.map((t) => t + WALK_LEN * X08);
const NODE_FADE = 120;
const HEAD_FADE = 200;
const END_IN = 1000;
/** Seven house cuts, tightening as they go, then the request's two. The first comes 800ms after the
 * walk has reached 46,656, long enough to read the number, not so long that a reader scrolling
 * past at an ordinary pace misses the cuts. */
const CUT_AT = [1200, 1560, 1890, 2190, 2470, 2740, 3000, 3900, 4700];
const CUT_LEN = 560;
/** The first 30% of a cut is the pick; the rest is the collapse. */
const PICK = 0.3;
/* A cut's question leaves before its leader and its row arrive, so the elbow never runs through the
 * words it is replacing and the same question is never printed twice. */
const Q_OUT = 90;
const ELBOW_LEN = 240;
const ROW_IN = 200;
const PHRASE_AT = [3800, 4600] as const;
const PHRASE_LEN = 240;
const PATH_AT = 5400;
const PATH_LEN = 500;
const ICON_AT = 5700;
const ICON_LEN = 300;
const REPLAY_AT = 6000;
const REPLAY_LEN = 240;
export const RUN_END = REPLAY_AT + REPLAY_LEN;

/** Replay: every cut undone together, a beat on the open tree, then the cuts again. */
const UNCUT = 600;
const PAUSE = 250;
export const REPLAY_END = UNCUT + PAUSE + RUN_END - CUT_AT[0]!;

/** Another request: the old one leaves (150), columns 8 and 9 reopen (400), the new one settles
 * as the first one did, column 9 700ms after column 8. */
const SW_OUT = 150;
const SW_REOPEN = 400;
const SW_CUT = [600, 1300] as const;
const SW_PHRASE = [500, 1200] as const;
const SW_PATH = 2000;
const SW_ICON = 2300;
export const SWITCH_END = SW_ICON + ICON_LEN;

export type State = {
  /** Growth of the edges leaving each station (0..9). */
  walk: number[];
  /** Each station's nodes (0..10), sketched. */
  lit: number[];
  /** Each column's question, sketched. */
  head: number[];
  /** "your app", sketched. */
  endA: number;
  /** Per column: the eased collapse, the pick, the question leaving, the elbow drawn, the row in. */
  t: number[];
  pick: number[];
  qOut: number[];
  elbow: number[];
  row: number[];
  /** The option each column keeps. */
  keep: number[];
  /** The request whose answers fill rows 8 and 9. */
  rowReq: number;
  /** Per request: its quote, its two settling phrases, and its icon with its end label. */
  quote: number[];
  marks: [number, number][];
  icon: number[];
  /** The green path: how much is drawn, and its opacity. */
  path: number;
  pathA: number;
  replay: number;
  count: number;
  /** The ghost: the dashed length the line used to be, seen while the cuts land and the line has no app yet. */
  ghost: number;
};

const keepOf = (r: number) => [...HOUSE_KEEP, ...REQUESTS[r]!.keep];
const only = (r: number, v: number) => REQUESTS.map((_, i) => (i === r ? v : 0));

/** The first run for request r. `shown` marks every run after the first: Replay stays on screen, and
 * "your app", already drawn, never drops back to the sketch. */
export function run(ms: number, r: number, shown = false): State {
  const p = CUT_AT.map((t0) => clamp01((ms - t0) / CUT_LEN));
  const t = p.map((v) => INOUT(clamp01((v - PICK) / (1 - PICK))));
  const crossed = LIT_AT.filter((x) => ms >= x).length;
  return {
    walk: WALK_AT.map((t0) => ease(ms, t0, WALK_LEN)),
    lit: COUNTS.map((_, st) => (st === 0 ? 1 : sk(clamp01((ms - LIT_AT[st - 1]!) / NODE_FADE)))),
    head: COLUMNS.map((_, c) => sk(clamp01((ms - LIT_AT[c]!) / HEAD_FADE))),
    endA: shown ? 1 : sk(clamp01((ms - END_IN) / HEAD_FADE)),
    t,
    pick: p.map((v) => OUT(clamp01(v / PICK))),
    qOut: CUT_AT.map((t0) => clamp01((ms - t0) / Q_OUT)),
    elbow: CUT_AT.map((t0) => ease(ms, t0 + Q_OUT, ELBOW_LEN)),
    row: CUT_AT.map((t0) => ease(ms, t0 + Q_OUT, ROW_IN)),
    keep: keepOf(r),
    rowReq: r,
    quote: only(r, 1),
    marks: REQUESTS.map((_, i) =>
      i === r ? [ease(ms, PHRASE_AT[0], PHRASE_LEN), ease(ms, PHRASE_AT[1], PHRASE_LEN)] : [0, 0],
    ),
    icon: only(r, ease(ms, ICON_AT, ICON_LEN)),
    path: ease(ms, PATH_AT, PATH_LEN),
    pathA: 1,
    replay: shown ? 1 : ease(ms, REPLAY_AT, REPLAY_LEN),
    count: crossed < LIT_AT.length ? RUNNING[crossed]! : paths(t),
    // grows with the cuts (the line is shorter by what they took), gives way to the app at its end
    ghost: clamp01(t.reduce((a, b) => a + b, 0)) * (1 - ease(ms, ICON_AT, ICON_LEN)),
  };
}

/** The finished frame for request r. */
export const done = (r: number) => run(RUN_END, r, true);
/** The faint sketch an armed plate waits in. */
export const sketch = (r: number) => run(0, r);

/** Replay for request r. */
export function undo(ms: number, r: number): State {
  if (ms >= UNCUT) return run(ms - UNCUT - PAUSE + CUT_AT[0]!, r, true);
  const d = done(r);
  // undone in reverse, in one 600ms breath: the app, its path and the lit words go first (150), the
  // rows and their leaders retract (250), the questions come back, and every column reopens at once
  const gone = 1 - ease(ms, 0, 150);
  const back = 1 - ease(ms, 0, 250);
  const v = 1 - ease(ms, 150, UNCUT - 150, INOUT);
  const cuts = COLUMNS.map(() => v);
  // the columns reopen together, but the count steps back through the numbers the cuts stepped down
  // (1, 3, 9 … 46,656), one column at a time from the last cut to the first. The steps are spaced
  // evenly in time (34ms apart, across the middle of the reopening, where the drawing visibly opens),
  // not in v: v moves slowly at both ends and fast in the middle, which would run several steps
  // together in one frame
  const last = COLUMNS.length - 1;
  const u = clamp01((ms - 150) / (UNCUT - 150));
  const counted = COLUMNS.map((_, c) => (u < 0.2 + 0.075 * (last - c) ? 1 : 0));
  return {
    ...d,
    t: cuts,
    pick: cuts,
    // a question comes back only once its column has nearly reopened, so neighbours never print over each other
    qOut: COLUMNS.map(() => clamp01(v / 0.2)),
    elbow: COLUMNS.map(() => back),
    row: COLUMNS.map(() => back),
    marks: d.marks.map(([a, b]) => [a * gone, b * gone]),
    icon: d.icon.map((x) => x * gone),
    pathA: gone,
    count: paths(counted),
    // the app leaves the end of the line, and the tail it covered shows until the columns have reopened
    ghost: clamp01(cuts.reduce((a, b) => a + b, 0)) * (1 - gone),
  };
}

/** From request a, finished, to request b, finished. Rows 1-7 and their elbows never move. */
export function swap(ms: number, a: number, b: number): State {
  const d = done(a);
  const out = ease(ms, 0, SW_OUT);
  const shut = 1 - ease(ms, 0, SW_REOPEN, INOUT);
  const open = ms >= SW_REOPEN;
  const t = [...d.t];
  const pick = [...d.pick];
  const qOut = [...d.qOut];
  const elbow = [...d.elbow];
  const row = [...d.row];
  for (const k of [0, 1] as const) {
    const c = 7 + k;
    const p = clamp01((ms - SW_CUT[k]) / CUT_LEN);
    t[c] = open ? INOUT(clamp01((p - PICK) / (1 - PICK))) : shut;
    pick[c] = open ? OUT(clamp01(p / PICK)) : shut;
    // the questions come back as the columns finish reopening, and leave again at the new cut
    qOut[c] = open ? clamp01((ms - SW_CUT[k]) / Q_OUT) : 1 - clamp01((ms - 280) / 120);
    elbow[c] = open ? ease(ms, SW_CUT[k] + Q_OUT, ELBOW_LEN) : 1 - out;
    row[c] = open ? ease(ms, SW_CUT[k] + Q_OUT, ROW_IN) : 1 - out;
  }
  const drawn = ms >= SW_PATH;
  return {
    ...d,
    t,
    pick,
    qOut,
    elbow,
    row,
    keep: keepOf(open ? b : a),
    rowReq: ms < SW_OUT ? a : b,
    quote: REQUESTS.map((_, i) => (i === a ? 1 - out : i === b ? ease(ms, SW_OUT, SW_OUT) : 0)),
    marks: REQUESTS.map((_, i) =>
      i === a ? [1, 1] : i === b ? [ease(ms, SW_PHRASE[0], PHRASE_LEN), ease(ms, SW_PHRASE[1], PHRASE_LEN)] : [0, 0],
    ),
    icon: REQUESTS.map((_, i) => (i === a ? 1 - out : i === b ? ease(ms, SW_ICON, ICON_LEN) : 0)),
    path: drawn ? ease(ms, SW_PATH, PATH_LEN) : 1,
    pathA: drawn ? 1 : 1 - out,
    count: paths(t),
  };
}

/* ------------------------------------------------------------------ *
 * The writer.
 * ------------------------------------------------------------------ */

export type El = HTMLElement | SVGElement;

/** A write that skips values already on the element: `style:` keys go to the inline style,
 * `text` to textContent, the rest are attributes (null removes). */
export type Put = (el: El, key: string, v: string | number | null) => void;

export function writer(): Put {
  const seen = new WeakMap<El, Map<string, string | null>>();
  return (el, key, v) => {
    const val = v === null ? null : String(v);
    let m = seen.get(el);
    if (!m) seen.set(el, (m = new Map<string, string | null>()));
    if (m.has(key) && m.get(key) === val) return;
    m.set(key, val);
    if (key === "text") el.textContent = val;
    else if (key.startsWith("style:")) {
      const prop = key.slice(6);
      if (val === null) el.style.removeProperty(prop);
      else el.style.setProperty(prop, val);
    } else if (val === null) el.removeAttribute(key);
    else el.setAttribute(key, val);
  };
}

export const r2 = (v: number) => Math.round(v * 100) / 100;
/** Straight hairlines sit on a half unit, so at 1:1 they cover one whole device pixel (rounding to
 * the nearest .5 could land on a whole unit and blur across two). */
export const crisp = (v: number) => Math.floor(v) + 0.5;

export const PAGE = "#08090a";
export const INK1 = "#f5f6f7";
export const LABEL = "rgba(255,255,255,.5)";
export const GREEN = "#4ea87a";

/** ink-2 (#c8cacf) to the light (#4ea87a), for a settling phrase; "" is the stylesheet's ink-2. */
function phraseColour(v: number): string {
  if (v <= 0) return "";
  if (v >= 1) return GREEN;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * v);
  return `rgb(${mix(200, 78)} ${mix(202, 168)} ${mix(207, 122)})`;
}

/** Node attributes shared by both compositions: the pick swells a kept option into a ring (green
 * when the request settled it) and dims its siblings to half before the collapse takes them to the
 * frame's .18. The end node gives way to the app's icon. */
export function nodeAttrs(f: Frame, S: State, i: number, icon: number) {
  const { station, j } = NODES[i]!;
  const c = station - 1;
  const end = station === 0 || station === STATIONS - 1;
  const kept = !end && j === S.keep[c];
  const pk = kept ? S.pick[c]! : 0;
  let alpha = f.nodes[i]!.alpha;
  if (!end && !kept) alpha = (1 - 0.5 * S.pick[c]!) * (1 - S.t[c]!) + 0.18 * S.t[c]!;
  if (station === STATIONS - 1) alpha *= 1 - icon;
  return {
    alpha,
    r: end ? 2.6 : r1(2 + 1.2 * pk),
    fill: end ? INK1 : pk > 0 ? PAGE : LABEL,
    stroke: pk > 0 ? (c >= 7 ? GREEN : INK1) : "none",
    opacity: r2(alpha * S.lit[station]!),
  };
}

/** Every element a composition's painter writes, found once. */
export type Comp = {
  nodes: El[];
  edges: El[];
  ticks: El[];
  elbows: El[];
  dots: El[];
  qs: El[];
  rows: El[];
  /** The narrow leaders (row 1 has two: the straight one and, for the narrowest phones, the jogged one);
   * each names its row in `data-lead`. */
  leads: El[];
  /** Rows 8 and 9's answer text. */
  answers: El[];
  icons: El[];
  labels: El[];
  path: El | null;
  ghost: El | null;
  ghostLine: El | null;
  yourApp: El | null;
  count: El | null;
  /** The count and its unit, together. */
  countBox: El | null;
  unit: El | null;
  replay: El | null;
};

export function collect(root: Element): Comp {
  const all = (sel: string) => [...root.querySelectorAll<El>(sel)];
  const indexed = (attr: string) => {
    const out: El[] = [];
    for (const el of all(`[${attr}]`)) out[Number(el.getAttribute(attr))] = el;
    return out;
  };
  const one = (sel: string) => root.querySelector<El>(sel);
  return {
    nodes: all("[data-node]"),
    edges: all("[data-edge]"),
    ticks: indexed("data-tick"),
    elbows: indexed("data-elbow"),
    dots: indexed("data-dot"),
    qs: indexed("data-q"),
    rows: indexed("data-row"),
    leads: all("[data-lead]"),
    answers: indexed("data-answer"),
    icons: indexed("data-icon"),
    labels: indexed("data-label"),
    path: one("[data-path]"),
    ghost: one("[data-ghost]"),
    ghostLine: one("[data-ghostline]"),
    yourApp: one("[data-yourapp]"),
    count: one("[data-count]"),
    countBox: one("[data-countbox]"),
    unit: one("[data-unit]"),
    replay: one("[data-replay]"),
  };
}

/** Nodes and edges, either orientation. */
export function paintLattice(c: Comp, f: Frame, S: State, put: Put) {
  const icon = Math.max(...S.icon);
  const alpha: number[] = [];
  c.nodes.forEach((el, i) => {
    const n = f.nodes[i]!;
    const a = nodeAttrs(f, S, i, icon);
    alpha[i] = nodeAttrs(f, S, i, 0).alpha;
    // the request's node never moves, and each composition places it where its leader lands (wide:
    // half a unit right of the axis's start, on the leader's crisp line)
    if (i > 0) {
      put(el, "cx", n.x);
      put(el, "cy", n.y);
    }
    put(el, "r", a.r);
    put(el, "fill", a.fill);
    put(el, "stroke", a.stroke);
    put(el, "opacity", a.opacity);
  });
  c.edges.forEach((el, i) => {
    const e = EDGES[i]!;
    const a = f.nodes[e.a]!;
    const b = f.nodes[e.b]!;
    const grow = S.walk[NODES[e.a]!.station]!;
    put(el, "x1", a.x);
    put(el, "y1", a.y);
    put(el, "x2", r1(a.x + (b.x - a.x) * grow));
    put(el, "y2", r1(a.y + (b.y - a.y) * grow));
    put(el, "opacity", r2(Math.min(alpha[e.a]!, alpha[e.b]!)));
  });
}

/** What both compositions show the same way: rows 8 and 9's answers, the end labels, the count and
 * Replay. */
export function paintCommon(c: Comp, S: State, put: Put) {
  const req = REQUESTS[S.rowReq]!;
  c.answers.forEach((el, k) => put(el, "text", k === 0 ? WHERE[req.keep[0]]! : WHO[req.keep[1]]!));
  // "your app" leaves in the first half of the icon's arrival and the end label takes its place in the
  // second, so the two never print over each other
  c.labels.forEach((el, r) => put(el, "style:opacity", r2(clamp01(2 * S.icon[r]! - 1))));
  // the count waits unseen until the walk starts counting: "1 way to build it" under the open tree is
  // the conclusion before the story
  if (c.countBox) {
    const a = clamp01(S.walk[0]! / 0.3);
    put(c.countBox, "style:opacity", a >= 1 ? null : r2(a));
  }
  if (c.count) put(c.count, "text", fmt(S.count));
  if (c.unit) put(c.unit, "text", S.count === 1 ? "way to build it" : "ways to build it");
  if (c.replay) {
    put(c.replay, "hidden", S.replay > 0 ? null : "");
    put(c.replay, "style:opacity", S.replay >= 1 ? null : r2(S.replay));
  }
}

/** The quotes live outside both compositions (one set serves either), so they are painted apart. */
export type Words = { quotes: El[]; marks: { el: El; r: number; m: number }[] };

export function collectWords(root: Element): Words {
  const quotes: El[] = [];
  for (const el of root.querySelectorAll<El>("[data-quote]")) quotes[Number(el.getAttribute("data-quote"))] = el;
  const marks = [...root.querySelectorAll<El>("[data-mark]")].map((el) => {
    const [r, m] = el.getAttribute("data-mark")!.split(":").map(Number);
    return { el, r: r!, m: m! };
  });
  return { quotes, marks };
}

export function paintWords(w: Words, S: State, put: Put) {
  w.quotes.forEach((el, r) => put(el, "style:opacity", r2(S.quote[r]!)));
  for (const { el, r, m } of w.marks) put(el, "style:color", phraseColour(S.marks[r]![m - 1]!) || null);
}

/* ------------------------------------------------------------------ *
 * Pieces both compositions render.
 * ------------------------------------------------------------------ */

/** One request, quoted, its settling words wrapped in marks the writer lights. The server renders
 * Pinch's lit. */
export function Quote({ r }: { r: number }) {
  return (
    <p data-quote={r} className="dc-quote" style={r === 0 ? undefined : { opacity: 0 }}>
      {"“"}
      {SEGMENTS[r]!.map((s, i) =>
        s.mark ? (
          <mark key={i} data-mark={`${r}:${s.mark}`} style={r === 0 ? { color: GREEN } : undefined}>
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      )}
      {"”"}
    </p>
  );
}

export type HotHow = "enter" | "leave" | "down" | "tap" | "focus" | "blur";
export type PlateProps = { onHot: (k: number, how: HotHow) => void; onReplay: () => void };

/** The seven answers are one tab stop: Tab lands on the row last visited (the first, to begin with),
 * the arrow keys walk the rest. Set on the DOM directly; the plates never re-render. The stops are
 * given once script runs (decisions.tsx): without it a row has nothing to tell, so it takes no focus. */
function rove(e: React.KeyboardEvent<HTMLElement>) {
  const rows = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-focus]") ?? [])];
  const i = rows.indexOf(e.currentTarget);
  const last = rows.length - 1;
  const to =
    e.key === "ArrowDown" || e.key === "ArrowRight"
      ? Math.min(i + 1, last)
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? Math.max(i - 1, 0)
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? last
            : -1;
  if (i < 0 || to < 0) return;
  e.preventDefault();
  rows[to]!.focus();
}
function holdStop(el: HTMLElement) {
  el.parentElement?.querySelectorAll<HTMLElement>("[data-focus]").forEach((r) => (r.tabIndex = r === el ? 0 : -1));
}

/** A row's pointer and focus wiring: hover (a mouse), a tap (touch or pen), or keyboard focus each
 * tell the readout what runs it. Rows 8 and 9 have nothing under the hood but your words, so they
 * take no focus. */
export function rowProps(k: number, onHot: PlateProps["onHot"]) {
  if (k >= 7) return {};
  return {
    "data-focus": k,
    onKeyDown: rove,
    onPointerEnter: (e: React.PointerEvent) => e.pointerType === "mouse" && onHot(k, "enter"),
    onPointerLeave: (e: React.PointerEvent) => e.pointerType === "mouse" && onHot(k, "leave"),
    onPointerDown: () => onHot(k, "down"),
    onPointerUp: (e: React.PointerEvent) => e.pointerType !== "mouse" && onHot(k, "tap"),
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      holdStop(e.currentTarget);
      onHot(k, "focus");
    },
    onBlur: () => onHot(k, "blur"),
  };
}

/** The foot: the count, and Replay once a run has ended. The server renders Replay hidden: it is
 * offered only where script with motion can play it. */
export function Foot({ onReplay }: { onReplay: () => void }) {
  return (
    <div className="dc-foot">
      <p data-countbox className="dc-count" aria-hidden>
        <span data-count className="t-count">
          1
        </span>
        <span data-unit className="dc-unit">
          way to build it
        </span>
      </p>
      <button data-replay type="button" hidden className="dc-replay" onClick={onReplay}>
        <Replay size={12} />
        Replay
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The wide composition.
 * ------------------------------------------------------------------ */

/** Plate units above the tree's origin: the corner marks and the request sit up here. The request
 * stays 24 below the top marks (decisions.css), so the 8 over that are air between the request and
 * the first of its nine answers: the rows read as the answers to a question, not as a tenth row. */
const TOP = 32;
/** Callout row k's height (the elbow's run and the row's centre). */
const rowY = (k: number) => 40 + 24 * k;
/** The elbows end here; the questions start 10 later, the answers at 642. */
const STACK_X = 460;
/** Open-column questions: odd columns on the upper tier, even on the lower (baselines). */
const tierY = (k: number) => (k % 2 === 0 ? 254 : 270);
/** The one baseline the ends write on: "your request", "your app", and the end label after it
 * (13/18 centred on 394, so its baseline is 399). */
const END_BASE = 399;

/** The request's node and its dashed leader share one crisp vertical, half a unit right of the axis's
 * start (60): the edges and the green path leaving it begin under the node, so nothing shows the half. */
const START_X = crisp(WIDE.axis0);
/** The green path is 1.5px: centred on a quarter unit past the axis it covers exactly three device
 * pixels at 2x (a hairline-sized line on the half unit would cover four, two of them soft). The rings
 * it runs through are 7 units wide, so the quarter is not seen. */
const PATH_Y = WIDE.cross + 0.25;
/** The "Under the hood" line: in the empty band under the ninth row, at the questions' column. */
const UNDER_Y = rowY(8) + 28;

const OPEN_W = frame(ALL_OPEN, keepOf(0), WIDE);
const F = frame(ALL_CUT, keepOf(0), WIDE);
const D0 = done(0);
const END_X = F.end[0];
const topNode = (k: number) => WIDE.cross - ((COLUMNS[k]!.n - 1) / 2) * WIDE.pitch;
/** Elbow k rises from its kept ring (on the axis once the cut has landed) to its row. It starts on the
 * ring's outer edge, r 3.2 plus half its 1px stroke, so leader and ring read as one mark. */
const elbowD = (x: number, k: number, foot = WIDE.cross) =>
  `M${crisp(x)} ${r1(foot - 3.7)}V${rowY(k) + 0.5}H${STACK_X}`;

export function paintWide(c: Comp, S: State, put: Put) {
  const f = frame(S.t, S.keep, WIDE);
  paintLattice(c, f, S, put);

  COLUMNS.forEach((_, k) => {
    const x = f.stations[k + 1]![0];
    const q = r2(S.head[k]! * (1 - S.qOut[k]!));
    const tick = c.ticks[k];
    if (tick) {
      put(tick, "x1", crisp(x));
      put(tick, "x2", crisp(x));
      put(tick, "opacity", q);
    }
    const label = c.qs[k];
    if (label) {
      put(label, "style:opacity", q);
      const d = r2((x - OPEN_W.stations[k + 1]![0]) / 10);
      put(label, "style:transform", d === 0 ? null : `translateX(${d}cqw)`);
    }
    const elbow = c.elbows[k];
    if (elbow) {
      put(elbow, "d", elbowD(x, k, f.nodes[nodeAt(k + 1, S.keep[k]!)]!.y));
      put(elbow, "stroke-dashoffset", r2(1 - S.elbow[k]!));
    }
    const dot = c.dots[k];
    if (dot) put(dot, "opacity", r2(clamp01((S.elbow[k]! - 0.85) / 0.15)));
    const row = c.rows[k];
    if (row) {
      const v = S.row[k]!;
      put(row, "style:opacity", v >= 1 ? null : r2(v));
      // each row rises 3px into place as its cut hands it the question
      put(row, "style:transform", v >= 1 || v <= 0 ? null : `translateY(${r2(3 * (1 - v))}px)`);
      // a row not yet arrived can be neither hovered nor focused
      put(row, "style:visibility", v <= 0 ? "hidden" : null);
    }
  });

  const [ex] = f.end;
  const d = r2((ex - END_X) / 10);
  const shift = d === 0 ? "" : `translateX(${d}cqw) `;
  const icon = Math.max(...S.icon);
  c.icons.forEach((el, r) => {
    const v = S.icon[r]!;
    put(el, "style:opacity", r2(v));
    put(el, "style:transform", v >= 1 && !shift ? null : `${shift}scale(${r2(0.85 + 0.15 * v)})`);
  });
  // a label rides with the end only while it shows: parked at 940, an unseen one would hang past the
  // plate (and the page) on the right
  c.labels.forEach((el, r) => put(el, "style:transform", S.icon[r]! > 0.5 ? shift || null : null));
  if (c.yourApp) {
    put(c.yourApp, "x", ex);
    put(c.yourApp, "opacity", r2(S.endA * (1 - clamp01(2 * icon))));
  }
  if (c.path) {
    put(c.path, "d", `M${WIDE.axis0} ${PATH_Y}H${ex}`);
    put(c.path, "stroke-dashoffset", r2(1 - S.path));
    put(c.path, "opacity", r2(S.pathA));
  }
  // The ghost keeps the length the line used to be while the cuts land; the icon arriving at the end
  // says where the line stopped, so the tail gives way to it. A request swapped after that moves
  // only the last two columns, and the finished picture does not grow its tail back.
  if (c.ghost) put(c.ghost, "opacity", r2(S.ghost));
  if (c.ghostLine) put(c.ghostLine, "x1", ex);
  paintCommon(c, S, put);
}

/** Place an overlay element at plate units (x, y). */
const at = (x: number, y: number) => ({ "--x": x, "--y": y + TOP }) as CSSProperties;

/** Corner marks: four 12-unit Ls, the plate's only drafting frame. */
const CORNERS = [
  `M0.5 ${12.5 - TOP}V${0.5 - TOP}H12.5`,
  `M987.5 ${0.5 - TOP}H999.5V${12.5 - TOP}`,
  "M0.5 427.5V439.5H12.5",
  "M987.5 439.5H999.5V427.5",
];

export const PlateWide = memo(function PlateWide({ onHot, onReplay }: PlateProps) {
  return (
    <div data-comp="w" className="dc-wide">
      <div className="dc-stage">
        <svg
          viewBox={`0 ${-TOP} 1000 ${440 + TOP}`}
          preserveAspectRatio="xMidYMin meet"
          className="dc-svg"
          fill="none"
          aria-hidden
          focusable="false"
        >
          <g stroke="var(--ink-stroke)">
            {CORNERS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <g stroke="var(--ink-faint)">
            {COLUMNS.map((_, k) => (
              <line
                key={k}
                data-tick={k}
                x1={crisp(F.stations[k + 1]![0])}
                y1={tierY(k) + 4}
                x2={crisp(F.stations[k + 1]![0])}
                y2={topNode(k) - 6}
                opacity={0}
              />
            ))}
            {/* the request drops into the tree: the leader lands on the start node's edge (r 2.6) */}
            <path d={`M${START_X} ${r1(WIDE.cross - 2.6)}V24`} strokeDasharray="2 3" />
            {EDGES.map((e, i) => {
              const a = F.nodes[e.a]!;
              const b = F.nodes[e.b]!;
              const alpha = Math.min(nodeAttrs(F, D0, e.a, 0).alpha, nodeAttrs(F, D0, e.b, 0).alpha);
              return <line key={i} data-edge x1={a.x} y1={a.y} x2={b.x} y2={b.y} opacity={r2(alpha)} />;
            })}
          </g>
          <path
            data-path
            d={`M${WIDE.axis0} ${PATH_Y}H${END_X}`}
            stroke={GREEN}
            strokeWidth={1.5}
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={0}
          />
          {/* the finished frame has the app's icon at the end of the line, so no tail past it */}
          <g data-ghost stroke="var(--ink-faint)" opacity={0}>
            <line
              data-ghostline
              x1={END_X}
              y1={crisp(WIDE.cross)}
              x2={F.ghost[0]}
              y2={crisp(WIDE.cross)}
              strokeDasharray="12 3 2 3 2 3"
            />
            <circle cx={F.ghost[0]} cy={WIDE.cross} r={2.6} fill={PAGE} stroke={LABEL} />
          </g>
          {COLUMNS.map((_, k) => (
            <g key={k}>
              <path
                data-elbow={k}
                d={elbowD(F.stations[k + 1]![0], k)}
                stroke={k >= 7 ? "var(--light-leader)" : "rgba(255,255,255,.22)"}
                pathLength={1}
                strokeDasharray="1 1"
                strokeDashoffset={0}
              />
              <circle data-dot={k} cx={STACK_X} cy={rowY(k) + 0.5} r={1.6} fill={k >= 7 ? GREEN : LABEL} stroke="none" />
            </g>
          ))}
          {NODES.map((_, i) => {
            const n = F.nodes[i]!;
            const a = nodeAttrs(F, D0, i, 1);
            return (
              <circle
                key={i}
                data-node
                cx={i === 0 ? START_X : n.x}
                cy={n.y}
                r={a.r}
                fill={a.fill}
                stroke={a.stroke}
                opacity={a.opacity}
              />
            );
          })}
          <text x={START_X} y={END_BASE} textAnchor="middle" className="fig-label">
            your request
          </text>
          <text data-yourapp x={END_X} y={END_BASE} textAnchor="middle" className="fig-label" opacity={0}>
            your app
          </text>
        </svg>

        <div className="dc-over">
          {COLUMNS.map((col, k) => (
            <div key={k} aria-hidden className="dc-q-at" style={at(OPEN_W.stations[k + 1]![0], tierY(k))}>
              <span data-q={k} className="dc-q" style={{ opacity: 0 }}>
                {col.q}
              </span>
            </div>
          ))}
          <div className="dc-rows" role="list" aria-label="The nine answers">
            {COLUMNS.map((col, k) => (
              <div key={k} role="listitem" data-row={k} className="dc-row" style={at(466, rowY(k))} {...rowProps(k, onHot)}>
                <span className="dc-row-q">{col.q}</span>
                {k < 7 ? (
                  <span className="dc-row-a">{col.a}</span>
                ) : (
                  <span className="dc-row-a dc-mine">
                    <span data-answer={k - 7}>{k === 7 ? WHERE[REQUESTS[0]!.keep[0]] : WHO[REQUESTS[0]!.keep[1]]}</span>
                    <span className="dc-from">from your request</span>
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* what runs the answer being read, where the eye already is (the foot is 400 units away) */}
          <div aria-hidden className="dc-under-at" style={at(466, UNDER_Y)}>
            {COLUMNS.slice(0, 7).map((col, k) => (
              <span key={k} data-under={k} className="dc-under">
                Under the hood: {col.under}
              </span>
            ))}
          </div>
          {REQUESTS.map((r, i) => (
            <div key={r.app} aria-hidden data-icon={i} className="dc-icon" style={{ ...at(END_X, WIDE.cross), opacity: i === 0 ? 1 : 0 }}>
              <AppIcon app={r.app} size={40} />
            </div>
          ))}
          {REQUESTS.map((r, i) => (
            <div key={r.app} aria-hidden className="dc-end-at" style={at(END_X, 394)}>
              <span data-label={i} className="dc-end" style={i === 0 ? undefined : { opacity: 0 }}>
                {r.end}
              </span>
            </div>
          ))}
        </div>
      </div>
      <Foot onReplay={onReplay} />
    </div>
  );
});
