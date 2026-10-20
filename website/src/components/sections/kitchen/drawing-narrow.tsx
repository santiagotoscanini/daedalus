/** The kitchen, narrow (the figure's column under 880px): the wide drawing cropped to the kitchen
 * itself, so the box on the counter stays large enough to read. It keeps the counter and cabinets,
 * the microwave and the clock, the box with its light and "still on", the riser above the box and
 * the five runs that end on it, which come in from the rest of the house out of frame. The machines
 * are listed under it (kitchen.tsx), since the rooms they stand in are cropped away.
 *
 * The crop has no loose ends. It is capped above by the attic floor's two lines, as in the wide
 * drawing, so the walls hang from something and the run to the gaming PC goes up through it to
 * where the PC stands; and every line that would leave the frame sideways (the two lines of the
 * floor, the ground, the runs) fades out over its last 24 units instead of stopping flat on the
 * gutter. The internet takes a shorter way out, with the same route through the counter and the
 * same break, and ends inside the frame, under its label.
 *
 * Drawn on the wide drawing's coordinates, and shown at the column's width, so its strokes do not
 * scale with it: kitchen.css gives every line a non-scaling 1px stroke, which keeps the hairlines
 * and the runs' 4/3 dashes the same as everywhere else on the page. */

import { RISER } from "./drawing";

/** The wide drawing's runs (drawing.tsx) as far as the frame, from the riser out to the edge they
 * leave by, in the same reveal order: study, home office, upstairs, living room, closet. The one
 * from upstairs goes up instead, to the attic floor's upper line, where the PC stands. */
const RUNS: readonly { id: string; d: string; reveal: string; at: number }[] = [
  { id: "macbook", d: "M500 354H350", reveal: "M350 354H500", at: 0 },
  { id: "laptop", d: "M500 361H350", reveal: "M350 361H500", at: 80 },
  { id: "gaming", d: "M500 354H602V330", reveal: "M602 330V354H500", at: 160 },
  { id: "iphone", d: "M500 382H650", reveal: "M650 382H500", at: 240 },
  { id: "oldpc", d: "M500 375H650", reveal: "M650 375H500", at: 320 },
];

/** What the frame shows: x 350 to 650 (the page axis in the middle), y 318 to 600. */
const FRAME = { x: 350, y: 318, w: 300, h: 282 } as const;
const BOX = `${FRAME.x} ${FRAME.y} ${FRAME.w} ${FRAME.h}`;

export function KitchenDrawingNarrow({ uid }: { uid: string }) {
  const mask = {
    maskUnits: "userSpaceOnUse",
    x: FRAME.x,
    y: FRAME.y,
    width: FRAME.w,
    height: FRAME.h,
  } as const;
  return (
    <svg
      viewBox={BOX}
      className="k-svg k-svg-narrow"
      fill="none"
      role="img"
      aria-label="Drawing: the box on the kitchen counter beside the microwave, a little smaller than it, with a cable from every other computer in the house running into it. Its cable to the internet is broken, and its status light is still on."
    >
      <defs>
        {RUNS.map((r) => (
          <mask key={r.id} id={`${uid}-n-${r.id}`} {...mask}>
            <path
              className="k-reveal m-draw"
              d={r.reveal}
              pathLength={1}
              style={{ ["--at" as string]: `${r.at}ms`, ["--for" as string]: "300ms" }}
            />
          </mask>
        ))}
        <mask id={`${uid}-n-riser`} {...mask}>
          <path
            className="k-reveal m-draw"
            d={RISER}
            pathLength={1}
            style={{ ["--at" as string]: "300ms", ["--for" as string]: "240ms" }}
          />
        </mask>
        <mask id={`${uid}-n-gap`} {...mask}>
          <rect x={FRAME.x} y={FRAME.y} width={FRAME.w} height={FRAME.h} fill="#fff" />
          <rect className="k-gap" x="596" y="562" width="24" height="20" fill="#000" />
        </mask>
        {/* the sideways fade: opaque from 24 units in, nothing at the frame's edge */}
        <linearGradient
          id={`${uid}-n-fade`}
          gradientUnits="userSpaceOnUse"
          x1={FRAME.x}
          y1="0"
          x2={FRAME.x + FRAME.w}
          y2="0"
        >
          <stop offset="0" stopColor="#000" />
          <stop offset=".08" stopColor="#fff" />
          <stop offset=".92" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <mask id={`${uid}-n-edge`} {...mask}>
          <rect x={FRAME.x} y={FRAME.y} width={FRAME.w} height={FRAME.h} fill={`url(#${uid}-n-fade)`} />
        </mask>
      </defs>

      <path className="k-f" d="M360 338V548M640 338V548M372 478V548H628V478M457 478V548M543 478V548M372 492H628" />
      <g className="k-dots">
        {[434, 440, 446, 452].flatMap((y) =>
          [452, 457.5, 463].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
        )}
      </g>

      {/* what leaves the frame sideways: the runs go behind the attic floor and the ground */}
      <g mask={`url(#${uid}-n-edge)`}>
        {RUNS.map((r) => (
          <path key={r.id} className="k-run" d={r.d} mask={`url(#${uid}-n-${r.id})`} />
        ))}
        <path className="k-s" d="M350 330H650M350 338H650M350 548H650" />
      </g>
      <path className="k-trunk" d={RISER} mask={`url(#${uid}-n-riser)`} />

      <path className="k-s" d="M366 470H634V478H366ZM446 424V464M590 401V393M590 401L596 404" />
      <g className="k-s">
        <rect x="380" y="418" width="88" height="52" rx="4" />
        <rect x="388" y="426" width="50" height="36" rx="3" />
        <circle cx="590" cy="401" r="12" />
      </g>
      <path className="k-s" strokeLinecap="round" d="M406 486H422M492 486H508M577 486H593" />

      <path className="k-s" d="M516 470V478H543V572H640" mask={`url(#${uid}-n-gap)`} />
      <path
        className="k-s m-fade"
        d="M592 577L600 567M616 577L624 567"
        style={{ ["--at" as string]: "1350ms", ["--for" as string]: "200ms" }}
      />

      <rect className="k-body" x="478.25" y="426.25" width="43.5" height="43.5" />
      <path className="k-f" d="M484 433H516M484 436H516M484 439H516M484 442H516M484 445H516" />
      <circle cx="508" cy="462" r="2.4" fill="var(--color-ok)" />
      <path className="k-s" strokeLinecap="round" d="M513.4 459.9A3 3 0 1 0 517.6 459.9M515.5 458.2V462" />

      <text
        className="fig-label m-fade k-still"
        x="534"
        y="466"
        style={{ ["--at" as string]: "1600ms", ["--for" as string]: "300ms" }}
      >
        still on
      </text>
      <text className="fig-label" x="500" y="596" textAnchor="middle">
        kitchen
      </text>
      {/* on the room tag's baseline, ending where the cable ends */}
      <text className="fig-label" x="640" y="596" textAnchor="end">
        internet
      </text>
    </svg>
  );
}
