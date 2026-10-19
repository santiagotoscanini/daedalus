/** FIG. 3, house to rack: where Pinch runs, drawn in the manifesto's ink. A house holds the box on
 * its kitchen counter, with Pinch's icon resting over it and the box's green light on; a data center
 * rack stands under the Vercel triangle with one empty, dashed slot near its top. A faint dashed
 * route marked "one click" leaves the box's top edge, rises through the roof, arches over the axis
 * and drops through the rack's top into the slot, where an open chevron points at it. That is the
 * house state, and the one the prerender, no-JS and reduced motion show.
 *
 * The move (driven from vercel.tsx) flies the icon along the route into the slot while a brighter
 * copy of the route draws in behind it, revealed by the same arc length the icon has travelled, so
 * the icon rides the tip of the trail all the way to the chevron. The icon comes to rest a few units
 * below the tip, on the slot's centre: it sinks there gradually (by the cube of the distance flown),
 * so its path never kinks. Then the light moves: the house's goes hollow, the slot turns solid and a
 * light comes on in the rack. The lights, the box and the slot read `data-at` on an ancestor
 * (vercel.css); the flight and the mask are written per frame through `place`.
 *
 * The route has no halo: where it crosses the roof and the rack's top a dash straddles the line, so
 * it reads as passing in front without notching either. Its dashes are stretched a fraction of a
 * percent (`pathLength`) and shifted (`strokeDashoffset`) so both crossings land mid-dash and a dash
 * runs into the chevron's tip; the trail repeats them exactly.
 *
 * Two drawings, one shown at a time by a container query: the wide one (960 x 296), only ever at
 * 1:1, and a narrow one (358 x 186), at 1:1 on a 390 phone and as wide as Pinch's card elsewhere
 * (its strokes stay 1px there). Coordinates are the spec's, nudged onto the pixel grid: a 1px
 * horizontal or vertical stroke sits on a half unit and the 1.5px subject stroke on a quarter, so at
 * 1x and 2x every hairline covers whole device pixels. Each rack holds its units at one pitch with
 * equal margins top and bottom, the slot first, with room above it for the chevron. Every number
 * below is a literal, computed once offline (no float drift between prerender and hydration). */

import { type Ref, useId } from "react";

import { AppIcon } from "~/components/landing/app-icon";
import { round1 } from "~/components/landing/motion";
import { MARKS } from "~/components/marks";

type Pt = readonly [number, number];

/** One flight, and the route it draws. */
interface Flight {
  /** the route's cubic: from the icon's resting centre (over the box's centre) to the chevron's tip
   * at the slot's top centre; it leaves straight up, the way the lead-in below it points */
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p1: Pt;
  /** the cubic's length, and the whole route's (the lead-in from the box's top edge, then the cubic) */
  cubic: number;
  total: number;
  /** how far below the tip the icon comes to rest: the slot's centre */
  drop: number;
  /** the icon's size at rest and in the slot (its `<AppIcon size>` is `from`, scaled from there) */
  from: number;
  to: number;
}

const WIDE_FLIGHT: Flight = {
  p0: [202, 196],
  c1: [202, -4],
  c2: [708, 31.9],
  p1: [790.5, 137.5],
  cubic: 674.887,
  total: 693.387,
  drop: 8,
  from: 20,
  to: 12,
};
const NARROW_FLIGHT: Flight = {
  p0: [86, 118],
  c1: [86, 16],
  c2: [266.2, 31.8],
  p1: [294.5, 65.5],
  cubic: 255.078,
  total: 267.578,
  drop: 6,
  from: 14,
  to: 8,
};

/** The routes as drawn (the lead-in, then the flights' cubics), their dashes (`pathLength`, offset),
 * and the chevrons: arms 7 (5 narrow) at 32 degrees either side of the end tangent. */
const WIDE_ROUTE = { d: "M202 214.5V196C202 -4 708 31.9 790.5 137.5", length: 693.03, offset: 5 };
const NARROW_ROUTE = { d: "M86 130.5V118C86 16 266.2 31.8 294.5 65.5", length: 265.86, offset: 5.82 };
const WIDE_CHEVRON = "M783.92 135.11L790.5 137.5L789.77 130.54";
const NARROW_CHEVRON = "M289.74 63.96L294.5 65.5L293.8 60.55";

/** The icon's resting transform, as rendered: its own size at its resting centre. */
const rest = (f: Flight) => `translate(${f.p0[0] - f.from / 2} ${f.p0[1] - f.from / 2})`;

// The flight is timed by distance along the curve, not by the curve's parameter, so the icon keeps
// pace with the trail (which the mask reveals by length). A cubic's parameter runs fast on the
// straight stretches and slow round the top; the table maps length back to parameter.
const SAMPLES = 128;
const point = (f: Flight, t: number): [number, number] => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [
    a * f.p0[0] + b * f.c1[0] + c * f.c2[0] + d * f.p1[0],
    a * f.p0[1] + b * f.c1[1] + c * f.c2[1] + d * f.p1[1],
  ];
};
const tables = new Map<Flight, number[]>();
const lengths = (f: Flight) => {
  let table = tables.get(f);
  if (!table) {
    table = [0];
    let [px, py] = f.p0;
    for (let i = 1; i <= SAMPLES; i++) {
      const [x, y] = point(f, i / SAMPLES);
      table.push(table[i - 1]! + Math.hypot(x - px, y - py));
      px = x;
      py = y;
    }
    tables.set(f, table);
  }
  return table;
};
const paramAt = (f: Flight, s: number) => {
  const table = lengths(f);
  const want = s * table[SAMPLES]!;
  let lo = 1;
  let hi = SAMPLES;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < want) lo = mid + 1;
    else hi = mid;
  }
  const a = table[lo - 1]!;
  const b = table[lo]!;
  return (lo - 1 + (b > a ? (want - a) / (b - a) : 0)) / SAMPLES;
};

/** The two things a frame of the move writes in one drawing. */
export interface Movers {
  icon: SVGGElement | null;
  trail: SVGPathElement | null;
}

const written = new WeakMap<Element, string>();
const write = (el: Element | null, name: string, value: string) => {
  if (!el || written.get(el) === value) return;
  written.set(el, value);
  el.setAttribute(name, value);
};

function placeOne(m: Movers, f: Flight, s: number) {
  const [x, y0] = point(f, s <= 0 ? 0 : s >= 1 ? 1 : paramAt(f, s));
  const y = y0 + f.drop * s * s * s;
  const size = f.from + (f.to - f.from) * s;
  const k = Math.round((size / f.from) * 1000) / 1000;
  write(
    m.icon,
    "transform",
    s <= 0 ? rest(f) : `translate(${round1(x - size / 2)} ${round1(y - size / 2)}) scale(${k})`,
  );
  // the trail: the lead-in at once, then the cubic as far as the icon has flown
  const shown = s <= 0 ? 0 : Math.min(1, (f.total - f.cubic + s * f.cubic) / f.total);
  write(m.trail, "stroke-dashoffset", String(round1(1000 * (1 - shown))));
}

/** Puts both drawings at `s` along the move (a share of the flight's length): 0 is the house, 1 the
 * rack. */
export function place(wide: Movers, narrow: Movers, s: number) {
  placeOne(wide, WIDE_FLIGHT, s);
  placeOne(narrow, NARROW_FLIGHT, s);
}

const LABEL = "Line drawing: a house holding the box on its counter, and a data center rack under the Vercel triangle, joined by an arc marked one click.";

/** useId, made safe inside url(#…). */
const useSafeId = () => useId().replace(/[^\w-]/g, "");

/** The route and its brighter trail: the faint dashed route, then the trail, the same dashes in a
 * lighter ink, shown only where the mask's stroke has been drawn; the chevron last. */
function Route({
  route,
  chevron,
  u,
  trail,
}: {
  route: { d: string; length: number; offset: number };
  chevron: string;
  u: string;
  trail: Ref<SVGPathElement>;
}) {
  const dashes = { pathLength: route.length, strokeDasharray: "3 3", strokeDashoffset: route.offset };
  return (
    <>
      <defs>
        <mask id={`${u}m`} maskUnits="userSpaceOnUse" x="-20" y="-80" width="1000" height="420">
          <path
            ref={trail}
            className="vc-reveal"
            d={route.d}
            pathLength={1000}
            fill="none"
            stroke="#fff"
            strokeWidth="8"
            strokeDasharray="1000 1000"
            strokeDashoffset="1000"
          />
        </mask>
      </defs>
      <path d={route.d} className="vc-route" {...dashes} />
      <path d={route.d} className="vc-trail" mask={`url(#${u}m)`} {...dashes} />
      <path d={chevron} className="vc-chevron" />
    </>
  );
}

/** The empty slot, a phantom line (long, dot, dot) drawn side by side so every corner is a whole
 * dash: each long side starts and ends on half a long dash (its pattern stretched a little to fit,
 * by `pathLength`), and each short side runs dash, dot, dash. The long sides overrun by half a unit
 * so the corner pixels are filled. */
function Slot({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const long = w + 1;
  const fit = 6 + 13 + 25 * Math.round((long - 25) / 25) + 6;
  const short = h - 1;
  const side = short >= 12 ? "4 2 1 2 4" : `${(short - 2) / 2} 2`;
  // one path per side: pathLength covers a whole path, and the pattern starts afresh on each
  return (
    <g className="vc-slot">
      {[y, y + h].map((yy) => (
        <path key={yy} d={`M${x - 0.5} ${yy}h${long}`} pathLength={fit} strokeDasharray="12 3 2 3 2 3" strokeDashoffset="6" />
      ))}
      {[x, x + w].map((xx) => (
        <path key={xx} d={`M${xx} ${y + 0.5}v${short}`} strokeDasharray={side} />
      ))}
    </g>
  );
}

export function WideDrawing({ icon, trail }: { icon: Ref<SVGGElement>; trail: Ref<SVGPathElement> }) {
  const u = useSafeId();
  return (
    <svg className="vc-svg vc-wide" viewBox="0 24 960 296" width="960" height="296" fill="none" role="img" aria-label={LABEL}>
      <g className="vc-s">
        <path d="M40 290.5H920" />
        <path d="M70.5 290.5V170.5L170.5 90.5L270.5 170.5V290.5" />
        <path d="M86 250.5H254M86 256.5H254" />
        <rect x="100.5" y="208.5" width="60" height="42" rx="3" />
        <rect x="690.5" y="120.5" width="200" height="170" />
      </g>
      <g className="vc-f">
        <path d="M92.5 256.5V286.5H248.5V256.5" />
        <rect x="106.5" y="214.5" width="38" height="30" rx="3" />
        <path d="M702.5 128V286M878.5 128V286" />
        <path d={TICKS} />
        {WIDE_UNITS.map((y) => (
          <rect key={y} x="714.5" y={y} width="152" height="14" />
        ))}
      </g>
      <Route route={WIDE_ROUTE} chevron={WIDE_CHEVRON} u={u} trail={trail} />
      {/* the box: the drawing's one subject stroke while Pinch runs on it, plain ink once it moves */}
      <rect className="vc-box-sub" x="172.25" y="214.25" width="59.5" height="36" />
      <rect className="vc-box-off" x="172.5" y="214.5" width="59" height="36" />
      <path className="vc-f-line" d="M178 220.5H226M178 224.5H226M178 228.5H226" />
      <circle className="vc-light-home" cx="222" cy="243" r="2.2" />
      {/* the slot: dashed and waiting, then solid, with the light that says Pinch runs here */}
      <Slot x={714.5} y={138.5} w={152} h={14} />
      <rect className="vc-slot-taken" x="714.25" y="138.25" width="152.5" height="14.5" />
      <circle className="vc-light-rack" cx="858.5" cy="145.5" r="2.2" />
      <path d={MARKS.vercel} transform="translate(778.5 83.608)" className="vc-tri" />
      <g ref={icon} transform={rest(WIDE_FLIGHT)}>
        <AppIcon app="pinch" size={WIDE_FLIGHT.from} />
      </g>
      {/* over the route's highest point, the arc it names, on the page's axis */}
      <text className="fig-label" x="480" y="40" textAnchor="middle">
        one click
      </text>
      <text className="fig-label" x="170.5" y="312" textAnchor="middle">
        your kitchen
      </text>
      <text className="fig-label" x="790.5" y="312" textAnchor="middle">
        a data center
      </text>
    </svg>
  );
}

export function NarrowDrawing({ icon, trail }: { icon: Ref<SVGGElement>; trail: Ref<SVGPathElement> }) {
  const u = useSafeId();
  return (
    <svg className="vc-svg vc-narrow" viewBox="0 10 358 186" width="358" height="186" fill="none" role="img" aria-label={LABEL}>
      <g className="vc-s">
        <path d="M0 170.5H358" />
        <path d="M14.5 170.5V112.5L64.5 72.5L114.5 112.5V170.5" />
        <path d="M22 150.5H106" />
        <rect x="28.5" y="128.5" width="36" height="22" rx="2" />
        <rect x="244.5" y="52.5" width="100" height="118" />
      </g>
      <g className="vc-f">
        <path d="M26.5 150.5V166.5H101.5V150.5" />
        <rect x="32.5" y="132.5" width="22" height="14" rx="1.5" />
        <path d="M252.5 58V166M336.5 58V166" />
        {NARROW_UNITS.map((y) => (
          <rect key={y} x="256.5" y={y} width="76" height="10" />
        ))}
      </g>
      <Route route={NARROW_ROUTE} chevron={NARROW_CHEVRON} u={u} trail={trail} />
      <rect className="vc-box-sub" x="72.25" y="130.25" width="27.5" height="20" />
      <rect className="vc-box-off" x="72.5" y="130.5" width="27" height="20" />
      <path className="vc-f-line" d="M77 135.5H95M77 138.5H95" />
      <circle className="vc-light-home" cx="94" cy="145" r="1.4" />
      <Slot x={256.5} y={66.5} w={76} h={10} />
      <rect className="vc-slot-taken" x="256.25" y="66.25" width="76.5" height="10.5" />
      <circle className="vc-light-rack" cx="326.5" cy="71.5" r="1.4" />
      <path d="M286.5 42L294.5 28.14L302.5 42Z" className="vc-tri" />
      <g ref={icon} transform={rest(NARROW_FLIGHT)}>
        <AppIcon app="pinch" size={NARROW_FLIGHT.from} />
      </g>
      <text className="fig-label" x="200.5" y="28" textAnchor="middle">
        one click
      </text>
      <text className="fig-label" x="64.5" y="189" textAnchor="middle">
        your kitchen
      </text>
      <text className="fig-label" x="294.5" y="189" textAnchor="middle">
        a data center
      </text>
    </svg>
  );
}

/** The units under the slot: 14 tall at a pitch of 20 in the wide rack, 10 at 16 in the narrow one
 * (a 6-unit gap in both), leaving the same margin above the slot as below the last unit. */
const WIDE_UNITS = [158.5, 178.5, 198.5, 218.5, 238.5, 258.5];
const NARROW_UNITS = [82.5, 98.5, 114.5, 130.5, 146.5];

/** The rails' 3-unit inward ticks, every 8 units. */
const TICKS = Array.from({ length: 20 }, (_, i) => {
  const y = 132.5 + i * 8;
  return `M702.5 ${y}h3M878.5 ${y}h-3`;
}).join("");
