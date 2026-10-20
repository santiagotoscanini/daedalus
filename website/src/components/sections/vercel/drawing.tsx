/** The move, drawn in the kitchen's isometric style (landing/iso.ts), so the page's two drawings are
 * one hand. On the left, your house, closed now, seen from the street: a gabled roof, a door, and in
 * one window the box's green light. Pinch's icon rests over its roof. On the right, a neighbourhood
 * of other people's houses, smaller and receding, all dark, and over them, flat and small, Vercel's
 * triangle. A faint arc joins the roof to the triangle.
 *
 * The move (driven from vercel.tsx): the icon rides the arc to the triangle while a brighter trail
 * draws in behind it, then the neighbourhood's windows light in Pinch's coral, one house after
 * another outward from under the triangle: the app now serves every family, each with its own
 * recipes. Your house keeps its green light, because it keeps building for you. The windows read
 * `data-at` on an ancestor (vercel.css); the flight and the trail are written per frame by `place`.
 * The house state is what the prerender, no-JS and reduced motion show.
 *
 * One drawing at every width: it scales with its column, and its lines keep 1px (iso.css). */

import type { CSSProperties, Ref } from "react";

import { AppIcon } from "~/components/landing/app-icon";
import { type V3, arc, arcAt, bounds, box, onX, onY, poly, pt } from "~/components/landing/iso";
import { MARKS } from "~/components/marks";

/** A house: walls, a roof along x, a door and a window on its street side. `s` scales it. */
function House({ at, s, light, delay }: { at: V3; s: number; light?: "home"; delay?: number }) {
  const [x, y, z] = at;
  const w = 20 * s;
  const d = 16 * s;
  const h = 11 * s;
  const ridge = 18 * s;
  const eave = 1 * s;
  const f = box(x, y, z, w, d, h);
  const back = poly([
    [x - eave, y - eave, z + h - eave * 0.6],
    [x + w + eave, y - eave, z + h - eave * 0.6],
    [x + w + eave, y + d / 2, z + ridge],
    [x - eave, y + d / 2, z + ridge],
  ]);
  const front = poly([
    [x - eave, y + d / 2, z + ridge],
    [x + w + eave, y + d / 2, z + ridge],
    [x + w + eave, y + d + eave, z + h - eave * 0.6],
    [x - eave, y + d + eave, z + h - eave * 0.6],
  ]);
  const gable = poly([
    [x + w, y, z + h],
    [x + w, y + d, z + h],
    [x + w, y + d / 2, z + ridge - eave * 0.4],
  ]);
  const win = onY(y + d, x + 4 * s, x + 9 * s, z + 4 * s, z + 8 * s);
  const door = onY(y + d, x + 12.5 * s, x + 16 * s, z, z + 7 * s);
  const side = onX(x + w, y + 5.5 * s, y + 10.5 * s, z + 3.5 * s, z + 7 * s);
  const glow = pt(x + 7.4 * s, y + d, z + 5.2 * s);
  return (
    <g>
      <path className="i-t vc-roof-back" d={back} />
      <path className="i-l" d={f.left} />
      <path className="i-r" d={f.right} />
      <path className="i-r vc-gable" d={gable} />
      <path className="i-t vc-roof" d={front} />
      <path className="i-glass" d={door} />
      <path className="i-glass vc-side" d={side} />
      <path
        className={light ? "i-glass" : "i-glass vc-win"}
        d={win}
        style={delay === undefined ? undefined : ({ "--d": `${delay}ms` } as CSSProperties)}
      />
      {light && <circle className="vc-home-light" cx={glow[0]} cy={glow[1]} r="2.4" />}
    </g>
  );
}

/** Your house, and where Pinch's icon rests over it. */
const HOME: V3 = [0, 16, 0];
const REST: V3 = [10, 24, 21.5];

/** The neighbourhood: four rows of five, back to front, so nearer houses are drawn over farther. */
const FIELD = (() => {
  const out: { at: V3; key: string; s: number }[] = [];
  const SIZES = [0.56, 0.5, 0.62, 0.52, 0.58, 0.5];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 4; i++) {
      const s = SIZES[(i * 2 + j * 3) % SIZES.length] ?? 0.55;
      out.push({ at: [42 + i * 19 + (j % 2) * 7, -28 + j * 17, 0], key: `${i}-${j}`, s });
    }
  }
  return out.sort((a, b) => a.at[0] + a.at[1] - (b.at[0] + b.at[1]));
})();

/** Where the triangle floats, over the middle of the neighbourhood. */
const TRI: V3 = [74, -9, 30];
const LIFT = 9;
/** Each house's window lights after the icon lands, outward from under the triangle. */
const delayOf = (at: V3) => Math.round(Math.hypot(at[0] + 5 - TRI[0], at[1] + 4 - TRI[1]) * 14);

const VIEW = (() => {
  const pts: V3[] = [
    [HOME[0] - 2, HOME[1] - 2, 0],
    [HOME[0] + 21, HOME[1] + 17, 0],
    [HOME[0] - 2, HOME[1] + 17, 0],
    [HOME[0] + 21, HOME[1] - 2, 0],
    [HOME[0] + 10, HOME[1] + 32, -9],
    [96, 21, -7],
    REST,
    [TRI[0], TRI[1], TRI[2] + 6],
    [(REST[0] + TRI[0]) / 2, (REST[1] + TRI[1]) / 2, (REST[2] + TRI[2]) / 2 + LIFT + 5],
    [REST[0], REST[1], REST[2] + 4],
    ...FIELD.flatMap(({ at }) => [at, [at[0] + 11, at[1] + 9, 0] as V3, [at[0] + 11, at[1], 0] as V3]),
  ];
  const [x, y, w, h] = bounds(pts, 16);
  return { x, y, w, h: h + 10 };
})();

/** The icon's size at rest, and in flight as it nears the triangle. */
const FROM = 30;
const TO = 16;

/** The two things a frame of the move writes. */
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
const r1 = (n: number) => Math.round(n * 10) / 10;

const iconAt = (s: number) => {
  const [x, y] = arcAt(REST, TRI, LIFT, s);
  const size = FROM + (TO - FROM) * s;
  const k = Math.round((size / FROM) * 1000) / 1000;
  return `translate(${r1(x - size / 2)} ${r1(y - size / 2)}) scale(${k})`;
};

/** Puts the move at `s` (0 is home, 1 is at the triangle): the icon on the arc, the trail behind it. */
export function place(m: Movers, s: number) {
  write(m.icon, "transform", iconAt(s));
  write(m.trail, "stroke-dashoffset", String(r1(1 - s)));
  write(m.icon, "opacity", s >= 1 ? "0" : "1");
}

export function VercelDrawing({ icon, trail }: { icon: Ref<SVGGElement>; trail: Ref<SVGPathElement> }) {
  const tri = pt(...TRI);
  const route = arc(REST, TRI, LIFT);
  const homeLabel = pt(10, 32, -6);
  const fieldLabel = pt(96, 21, -4);
  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      className="iso vc-svg"
      role="img"
      aria-label="Drawing: your house, with the box's green light in its window and Pinch's icon over the roof, and a neighbourhood of other houses under Vercel's triangle, joined by an arc."
    >
      {/* the ground line each house stands on is the page; the houses, back to front */}
      <g className="vc-far">
        {FIELD.map(({ at, key, s }) => (
          <House key={key} at={at} s={s} delay={delayOf(at)} />
        ))}
      </g>
      <House at={HOME} s={1} light="home" />

      <path className="vc-route" d={route} />
      <path ref={trail} className="vc-trail" d={route} pathLength={1} strokeDasharray="1 1" strokeDashoffset="1" />

      <path
        className="vc-tri"
        d={MARKS.vercel}
        transform={`translate(${r1(tri[0] - 12)} ${r1(tri[1] - 13)})`}
      />

      <g ref={icon} transform={iconAt(0)}>
        <AppIcon app="pinch" size={FROM} />
      </g>

      <text x={homeLabel[0]} y={homeLabel[1]} textAnchor="middle">
        Your house
      </text>
      <text x={fieldLabel[0]} y={fieldLabel[1]} textAnchor="middle">
        Everyone else
      </text>
    </svg>
  );
}
