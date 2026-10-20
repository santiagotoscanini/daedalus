/** The kitchen, drawn: a one-storey house in isometric cutaway, its two back walls standing and its
 * front open like a doll's house, six rooms on one floor. The box sits on the kitchen counter beside
 * the microwave, smaller than it, its green light the figure's only colour. Every other computer in
 * the house stands where people keep one: a MacBook on the study desk, a work laptop in the home
 * office, a gaming tower with a glass side beside the bedroom desk, an old PC on the hall closet's
 * shelf, an iPhone left on the sofa. A thin arc rises from each and lands on the box, and one more
 * leaves the box for the internet and is broken: the house keeps working without it.
 *
 * The style is the landing's isometric kit (landing/iso.ts): boxes as three tones of the page's grey
 * with one hairline edge, the cut tops of the walls a shade lighter, as an architect's section shows
 * them. It scales with its column; the hairlines stay 1px (kitchen.css).
 *
 * Each machine is a button that names itself, drawn in its place so the scene keeps its depth order;
 * pointing at it, focusing it or tapping it lights its edges and its arc, and the readout under the
 * drawing (kitchen.tsx) says what it lends the house. Pointing at the box lights every arc. */

import type { CSSProperties, FocusEvent, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { type V3, arc, arcAt, bounds, box, circle, corners, line, onX, onY, onZ, pt } from "~/components/landing/iso";
import { MACHINES, type MachineId, readout } from "./machines";

export interface MachineHandlers {
  onPointerEnter: (e: PointerEvent<SVGGElement>) => void;
  onPointerLeave: (e: PointerEvent<SVGGElement>) => void;
  onPointerDown: (e: PointerEvent<SVGGElement>) => void;
  onFocus: (e: FocusEvent<SVGGElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<SVGGElement>) => void;
}

type B6 = readonly [number, number, number, number, number, number];

/** One box, as its three faces. `tone` swaps the faces' fills (a wall, a cushion, a black screen). */
function Bx({ b, tone }: { b: B6; tone?: "wall" | "soft" | "dark" }) {
  const f = box(...b);
  return (
    <g className={tone ? `i-${tone}` : undefined}>
      <path className="i-t" d={f.top} />
      <path className="i-l" d={f.left} />
      <path className="i-r" d={f.right} />
    </g>
  );
}

/** Lines drawn on a surface: seams, shelf edges, a door's split. */
function Ln({ d, faint }: { d: string; faint?: boolean }) {
  return <path className={faint ? "i-seam i-faint" : "i-seam"} d={d} />;
}

const WALL_H = 24;
const PART_H = 9;

/** Where each machine's arc starts, and where they all land: on the box's lid. */
const AT_BOX: V3 = [48.6, 5.5, 11.4];
const ANCHOR: Record<Exclude<MachineId, "box">, V3> = {
  macbook: [3.4, 14.5, 11.6],
  laptop: [80.5, 3.4, 11.4],
  gaming: [91, 35.5, 10.4],
  oldpc: [4.8, 43, 4],
  iphone: [47.7, 36.3, 5.3],
};
/** How high each arc rises over the midpoint of its run, in units. */
const LIFT: Record<Exclude<MachineId, "box">, number> = {
  macbook: 13,
  laptop: 11,
  gaming: 15,
  oldpc: 17,
  iphone: 12,
};
/** The order the arcs draw in, and when (ms after the figure plays). */
const ARCS: readonly { id: Exclude<MachineId, "box">; at: number }[] = [
  { id: "macbook", at: 0 },
  { id: "laptop", at: 110 },
  { id: "gaming", at: 220 },
  { id: "oldpc", at: 330 },
  { id: "iphone", at: 440 },
];
/** The internet: out of the box, over the back wall, broken a little past halfway. */
const NET_B: V3 = [70, -22, 40];
const NET_LIFT = 6;
const NET_CUT = (() => {
  const a = arcAt(AT_BOX, NET_B, NET_LIFT, 0.6);
  const b = arcAt(AT_BOX, NET_B, NET_LIFT, 0.68);
  return `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
})();

/** Each machine's boxes: its drawing and, through `corners`, its hit area and focus ring. */
const P = {
  box: [46.4, 3.4, 9.2, 4.4, 4.2, 2.2],
  macBase: [3, 12, 7.8, 3.8, 5, 0.3],
  macLid: [3, 12, 8.1, 0.3, 5, 3.5],
  lapBase: [78, 3.2, 7.8, 5, 3.4, 0.3],
  lapLid: [78, 3, 8.1, 5, 0.3, 3.3],
  gaming: [89, 31.6, 0, 4, 8, 10.4],
  oldpc: [2.4, 39, 0.6, 4.8, 8, 3.4],
  iphone: [47, 35, 5.1, 1.4, 2.7, 0.2],
} as const satisfies Record<string, B6>;
const PARTS: Record<MachineId, readonly B6[]> = {
  box: [P.box],
  macbook: [P.macBase, P.macLid],
  laptop: [P.lapBase, P.lapLid],
  gaming: [P.gaming],
  oldpc: [P.oldpc],
  iphone: [P.iphone],
};

const hit = (id: MachineId, pad: number) =>
  bounds(
    PARTS[id].flatMap((b) => corners(...b)),
    pad,
  );

/** The drawing's frame: the house and the end of the internet line, with a margin. */
const VIEW = (() => {
  const [x, y, w, h] = bounds(
    [
      [0, 0, -2],
      [100, 0, -2],
      [100, 60, -2],
      [0, 60, -2],
      [0, 0, WALL_H],
      [0, 60, WALL_H],
      NET_B,
    ],
    14,
  );
  return { x, y, w: w + 60, h };
})();
export const KITCHEN_RATIO = VIEW.h / VIEW.w;

/** The machines' own drawings (the box is drawn in its place on the counter). */
function Machine({ id }: { id: Exclude<MachineId, "box"> }) {
  switch (id) {
    case "macbook":
      return (
        <>
          <Bx b={P.macBase} />
          <Bx b={P.macLid} />
          <path className="i-glass" d={onX(3.3, 12.4, 16.6, 8.5, 11.2)} />
          <Ln d={onZ(8.1, 3.6, 6.2, 13, 16)} faint />
        </>
      );
    case "laptop":
      return (
        <>
          <Bx b={P.lapBase} />
          <Bx b={P.lapLid} />
          <path className="i-glass" d={onY(3.3, 78.4, 82.6, 8.5, 11)} />
          <Ln d={onZ(8.1, 79, 82, 3.9, 6)} faint />
        </>
      );
    case "gaming":
      return (
        <>
          <Bx b={P.gaming} />
          {/* the glass side, and through it the graphics card with its two fans */}
          <path className="i-glass" d={onX(93, 32.4, 38.8, 0.8, 9.6)} />
          <Ln d={onX(93, 33.2, 38, 3.4, 5.4)} />
          <Ln d={circle("x", [93, 34.6, 4.4], 0.75)} faint />
          <Ln d={circle("x", [93, 36.6, 4.4], 0.75)} faint />
          {/* the front: a power button and a vent */}
          <Ln
            d={line([
              [89.6, 39.6, 9.2],
              [92.4, 39.6, 9.2],
            ])}
          />
          <Ln d={onY(39.6, 89.8, 92.2, 1.2, 6.4)} faint />
        </>
      );
    case "oldpc":
      return (
        <>
          <Bx b={P.oldpc} />
          {/* a case from another decade, lying flat: its drive bay and its button */}
          <Ln d={onX(7.2, 40, 44, 2.2, 3.2)} />
          <Ln d={onX(7.2, 45, 46, 1.4, 2)} faint />
        </>
      );
    case "iphone":
      return (
        <>
          <Bx b={P.iphone} tone="dark" />
          <path className="i-glass" d={onZ(5.3, 47.15, 48.25, 35.2, 37.5)} />
        </>
      );
  }
}

function Group({
  id,
  active,
  bind,
  children,
}: {
  id: MachineId;
  active: boolean;
  bind: MachineHandlers;
  children: ReactNode;
}) {
  const [x, y, w, h] = hit(id, 8);
  const [rx, ry, rw, rh] = hit(id, 5);
  return (
    <g
      className="k-mach"
      role="button"
      tabIndex={0}
      aria-label={readout(MACHINES[id])}
      data-on={active || undefined}
      {...bind}
    >
      <rect className="k-hit" x={x} y={y} width={w} height={h} />
      {children}
      <rect className="k-ring" x={rx} y={ry} width={rw} height={rh} rx="5" />
    </g>
  );
}

const at = (ms: number, dur: number) => ({ "--at": `${ms}ms`, "--for": `${dur}ms` }) as CSSProperties;

export function KitchenDrawing({
  active,
  bind,
}: {
  active: MachineId | null;
  bind: (id: MachineId) => MachineHandlers;
}) {
  const lit = (id: MachineId) => active === id || (active === "box" && id !== "box");
  const g = (id: MachineId) => ({ id, active: lit(id), bind: bind(id) });
  const label = pt(...NET_B);
  const light = pt(50.1, 7.6, 10.2);

  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      className="iso k-svg"
      role="group"
      aria-label="Drawing: a house in cutaway, six rooms on one floor. The box sits on the kitchen counter beside the microwave, and an arc runs to it from every other computer in the house. Its line to the internet is broken, and its light is still on."
    >
      <g aria-hidden="true">
        {/* the floor, and the kitchen's tiles */}
        <Bx b={[0, 0, -2, 100, 60, 2]} tone="wall" />
        <path className="i-floor" d={onZ(0, 0, 100, 0, 60)} />
        <Ln
          faint
          d={[38, 42, 46, 50, 54, 58, 62]
            .map((x) =>
              line([
                [x, 1.6, 0],
                [x, 29.5, 0],
              ]),
            )
            .concat(
              [5.6, 9.6, 13.6, 17.6, 21.6, 25.6].map((y) =>
                line([
                  [34.5, y, 0],
                  [66.5, y, 0],
                ]),
              ),
            )
            .join("")}
        />

        {/* the two walls that stand, with their windows */}
        <Bx b={[0, 0, 0, 100, 1.6, WALL_H]} tone="wall" />
        <path className="i-sky" d={onY(1.6, 40, 54, 12.5, 20)} />
        <Ln
          d={
            line([
              [47, 1.6, 12.5],
              [47, 1.6, 20],
            ]) +
            line([
              [40, 1.6, 16.2],
              [54, 1.6, 16.2],
            ])
          }
        />
        <path className="i-sky" d={onY(1.6, 74, 88, 12.5, 20)} />
        <Ln
          d={line([
            [81, 1.6, 12.5],
            [81, 1.6, 20],
          ])}
        />
        <Bx b={[0, 1.6, 0, 1.6, 58.4, WALL_H]} tone="wall" />
        <path className="i-sky" d={onX(1.6, 8, 21, 12.5, 20)} />
        <Ln
          d={line([
            [1.6, 14.5, 12.5],
            [1.6, 14.5, 20],
          ])}
        />
        {/* the skirting, where the floor meets them */}
        <Ln
          faint
          d={line([
            [1.6, 60, 0.6],
            [1.6, 1.6, 0.6],
            [100, 1.6, 0.6],
          ])}
        />

        {/* ---- back row: the study ---- */}
        <Bx b={[14, 1.6, 0, 12, 3.6, 16]} />
        <Ln
          d={[4, 8, 12]
            .map((z) =>
              line([
                [14, 5.2, z],
                [26, 5.2, z],
              ]),
            )
            .join("")}
        />
        <g className="i-soft">
          {(
            [
              [14.8, 4, 1.2, 3.2],
              [16.2, 4, 0.9, 2.6],
              [17.4, 4, 1.4, 3.4],
              [21, 8, 1, 3],
              [22.2, 8, 1.3, 3.4],
              [15, 12, 2.6, 1],
              [15.2, 13, 2.2, 0.9],
            ] as const
          ).map(([x, z, w, h]) => (
            <Bx key={`${x}-${z}`} b={[x, 2.2, z, w, 2.6, h]} />
          ))}
        </g>
        {/* the desk against the side wall */}
        <Bx b={[8, 21, 0, 0.8, 0.8, 7]} />
        <Bx b={[8, 8, 0, 0.8, 0.8, 7]} />
        <Bx b={[1.6, 8, 7, 7.6, 14, 0.8]} />
        <Group {...g("macbook")}>
          <Machine id="macbook" />
        </Group>
        {/* the chair */}
        <Bx b={[12.6, 14.6, 0, 0.6, 0.6, 4.6]} />
        <Bx b={[11, 13, 4.6, 4.2, 4, 0.7]} tone="soft" />
        <Bx b={[15.2, 13, 4.6, 0.6, 4, 5]} tone="soft" />

        {/* partition: study | kitchen */}
        <Bx b={[33.5, 1.6, 0, 1, 10.4, PART_H]} tone="wall" />
        <Bx b={[33.5, 20, 0, 1, 9.5, PART_H]} tone="wall" />

        {/* ---- back row: the kitchen ---- */}
        <Bx b={[36, 1.6, 0, 22, 6.4, 8.4]} />
        <Ln
          d={[41.5, 47, 52.5]
            .map((x) =>
              line([
                [x, 8, 0.6],
                [x, 8, 8],
              ]),
            )
            .join("")}
        />
        <Ln
          d={[38.4, 43.9, 49.4, 54.9]
            .map((x) =>
              line([
                [x, 8, 7],
                [x + 1.8, 8, 7],
              ]),
            )
            .join("")}
        />
        <Bx b={[35.6, 1.6, 8.4, 22.8, 7, 0.8]} tone="soft" />
        {/* the fridge */}
        <Bx b={[58.4, 1.6, 0, 7.6, 7, 21]} />
        <Ln
          d={
            line([
              [58.4, 8.6, 13.4],
              [66, 8.6, 13.4],
            ]) +
            line([
              [59.4, 8.6, 15],
              [59.4, 8.6, 18],
            ]) +
            line([
              [59.4, 8.6, 8],
              [59.4, 8.6, 11.6],
            ])
          }
        />
        {/* the microwave: its window and keypad */}
        <Bx b={[37, 2.2, 9.2, 7.4, 5.2, 4.4]} />
        <path className="i-glass" d={onY(7.4, 37.6, 42, 9.9, 12.9)} />
        <Ln
          d={line([
            [42.6, 7.4, 9.6],
            [42.6, 7.4, 13.2],
          ])}
        />
        <g className="i-dots">
          {[0, 1, 2].flatMap((r) =>
            [0, 1].map((c) => {
              const [x, y] = pt(43.2 + c * 0.6, 7.4, 12.6 - r * 0.8);
              return <circle key={`${r}-${c}`} cx={x} cy={y} r="0.9" />;
            }),
          )}
        </g>
        {/* a cutting board, and a pot of herbs by the window */}
        <Bx b={[53, 3.2, 9.2, 4.2, 3.6, 0.4]} tone="soft" />
        <Bx b={[54.6, 2.4, 9.6, 1.8, 1.8, 1.6]} />
        <path className="i-leaf" d={circle("z", [55.5, 3.3, 12.2], 1.5)} />

        {/* the box, the drawing's subject, between the microwave and the board */}
        <Group {...g("box")}>
          <g className="k-box">
            <Bx b={P.box} />
            <Ln d={onZ(11.4, 47, 50.2, 4, 7)} faint />
          </g>
          <circle className="k-light" cx={light[0]} cy={light[1]} r="2.2" />
        </Group>

        {/* partition: kitchen | office */}
        <Bx b={[66.5, 1.6, 0, 1, 12.4, PART_H]} tone="wall" />
        <Bx b={[66.5, 22, 0, 1, 7.5, PART_H]} tone="wall" />

        {/* ---- back row: the home office ---- */}
        <Bx b={[88.6, 1.6, 0, 0.8, 0.8, 7]} />
        <Bx b={[88.6, 7.6, 0, 0.8, 0.8, 7]} />
        <Bx b={[72, 1.6, 7, 18, 6.8, 0.8]} />
        <Bx b={[72.6, 7.6, 0, 0.8, 0.8, 7]} />
        <Group {...g("laptop")}>
          <Machine id="laptop" />
        </Group>
        <Bx b={[85.4, 3.6, 7.8, 1.3, 1.3, 1.5]} />
        <Bx b={[79.4, 12.4, 0, 0.6, 0.6, 4.6]} />
        <Bx b={[78, 11, 4.6, 4, 4, 0.7]} tone="soft" />
        <Bx b={[78, 15, 4.6, 4, 0.6, 5]} tone="soft" />

        {/* the wall between the back rooms and the front ones, with its doorways */}
        {(
          [
            [1.6, 8.4],
            [18, 27],
            [53, 17],
            [78, 22],
          ] as const
        ).map(([x, w]) => (
          <Bx key={x} b={[x, 29.5, 0, w, 1, PART_H]} tone="wall" />
        ))}

        {/* ---- front row: the hall closet's open shelves ---- */}
        <Bx b={[1.6, 36, 0, 6.4, 0.8, 14]} />
        <Bx b={[1.6, 36.8, 0, 6.4, 16.4, 0.6]} />
        <Group {...g("oldpc")}>
          <Machine id="oldpc" />
        </Group>
        <Bx b={[1.6, 36.8, 4.6, 6.4, 16.4, 0.6]} />
        <g className="i-soft">
          <Bx b={[2.4, 38, 5.2, 4.8, 5, 3]} />
          <Bx b={[2.4, 44, 5.2, 4.8, 4, 2]} />
        </g>
        <Bx b={[1.6, 36.8, 9.2, 6.4, 16.4, 0.6]} />
        <Bx b={[2.6, 41, 9.8, 4, 6, 2.4]} tone="soft" />
        <Bx b={[1.6, 36.8, 13.4, 6.4, 16.4, 0.6]} />
        <Bx b={[1.6, 53.2, 0, 6.4, 0.8, 14]} />
        {/* a pair of shoes by the doorway */}
        <Bx b={[16, 33, 0, 3, 1.4, 0.9]} tone="soft" />
        <Bx b={[16, 34.8, 0, 3, 1.4, 0.9]} tone="soft" />

        {/* partition: closet | living room */}
        <Bx b={[33.5, 30.5, 0, 1, 9.5, PART_H]} tone="wall" />
        <Bx b={[33.5, 48, 0, 1, 12, PART_H]} tone="wall" />

        {/* ---- front row: the living room ---- */}
        <path className="i-rug" d={onZ(0.05, 39, 59, 42, 54)} />
        <Ln d={onZ(0.05, 40, 58, 43, 53)} faint />
        <Bx b={[38, 31.6, 4, 22, 2, 5]} tone="soft" />
        <Bx b={[38, 31.6, 0, 22, 7.4, 4]} tone="soft" />
        <Bx b={[38, 33.6, 4, 2.5, 5.4, 2.4]} tone="soft" />
        <Bx b={[40.5, 33.6, 4, 8.5, 5.4, 1]} tone="soft" />
        <Bx b={[49, 33.6, 4, 8.5, 5.4, 1]} tone="soft" />
        <Group {...g("iphone")}>
          <Machine id="iphone" />
        </Group>
        <Bx b={[57.5, 33.6, 4, 2.5, 5.4, 2.4]} tone="soft" />
        {/* the coffee table */}
        <Bx b={[44.6, 48.4, 0, 0.6, 0.6, 3.4]} />
        <Bx b={[52.8, 48.4, 0, 0.6, 0.6, 3.4]} />
        <Bx b={[44, 44, 3.4, 10, 5, 0.7]} />
        {/* a plant in the corner */}
        <Bx b={[62, 31.8, 0, 3, 3, 3.6]} />
        <path className="i-leaf" d={circle("z", [63.5, 33.3, 7], 2.6)} />
        <path className="i-leaf" d={circle("z", [62.8, 33.9, 9.4], 1.8)} />

        {/* partition: living room | bedroom */}
        <Bx b={[66.5, 30.5, 0, 1, 11.5, PART_H]} tone="wall" />
        <Bx b={[66.5, 50, 0, 1, 10, PART_H]} tone="wall" />

        {/* ---- front row: the bedroom ---- */}
        <Bx b={[72.6, 36.6, 0, 0.8, 0.8, 7]} />
        <Bx b={[72, 31.6, 7, 16, 6, 0.8]} />
        <Bx b={[86.6, 36.6, 0, 0.8, 0.8, 7]} />
        {/* the monitor, on its stand, and a keyboard */}
        <Bx b={[79.4, 32.6, 7.8, 1.2, 1.2, 1]} />
        <Bx b={[75.6, 32.2, 8.8, 8.8, 0.4, 5]} tone="dark" />
        <path className="i-glass" d={onY(32.6, 76, 84, 9.2, 13.4)} />
        <Bx b={[77.6, 34.6, 7.8, 4.4, 1.6, 0.25]} tone="soft" />
        <Group {...g("gaming")}>
          <Machine id="gaming" />
        </Group>
        {/* the bed, headboard to the partition */}
        <Bx b={[68.6, 45, 0, 1, 12, 8]} />
        <Bx b={[69.6, 45, 0, 17, 12, 2.2]} />
        <Bx b={[69.6, 45.2, 2.2, 16.8, 11.6, 2.2]} tone="soft" />
        <Bx b={[70.4, 46.4, 4.4, 3.4, 9.2, 1]} tone="soft" />
        <Ln
          faint
          d={line([
            [77, 45.2, 4.4],
            [77, 56.8, 4.4],
          ])}
        />
      </g>

      {/* every machine's arc to the box, and the box's broken line to the internet */}
      <g aria-hidden="true" className="k-arcs">
        {ARCS.map(({ id, at: ms }) => {
          const [x, y] = pt(...ANCHOR[id]);
          return (
            <g key={id} className="k-arc" data-on={lit(id) || undefined}>
              <path className="k-arc-line m-draw" pathLength={1} d={arc(ANCHOR[id], AT_BOX, LIFT[id])} style={at(ms, 560)} />
              <circle className="k-arc-end m-fade" cx={x} cy={y} r="2" style={at(ms, 200)} />
            </g>
          );
        })}
        <path className="k-net-line m-draw" pathLength={1} d={arc(AT_BOX, NET_B, NET_LIFT)} style={at(900, 500)} />
        <path className="k-net-cut m-fade" d={NET_CUT} style={at(1400, 240)} />
        <text className="k-net-label" x={label[0] + 10} y={label[1] + 4}>
          Internet
        </text>
      </g>
    </svg>
  );
}
