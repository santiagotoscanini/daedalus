/** The kitchen, narrow (the figure's column under 880px): the wide drawing cropped to the kitchen
 * itself, so the box on the counter stays large enough to read. It keeps the counter and cabinets,
 * the microwave and the clock, the box with its light and "still on", the riser above the box and
 * the five runs that end on it, which come in from the rest of the house out of frame, cut by the
 * drawing's edges as its walls and floor are. Their dashes start at the riser, so the runs that lie
 * side by side leave it in phase. The internet takes a shorter way out, with the same route through
 * the counter and the same break. The machines are listed under it (kitchen.tsx), since the rooms
 * they stand in are cropped away.
 *
 * Drawn on the wide drawing's coordinates, and shown at the column's width, so its strokes do not
 * scale with it: kitchen.css gives every line a non-scaling 1px stroke, which keeps the hairlines
 * and the runs' 4/3 dashes the same as everywhere else on the page. */

import { RISER } from "./drawing";

/** The wide drawing's runs (drawing.tsx) as far as the frame, from the riser out to the edge they
 * leave by, in the same reveal order: study, home office, upstairs, living room, closet. */
const RUNS: readonly { id: string; d: string; reveal: string; at: number }[] = [
  { id: "macbook", d: "M500 354H350", reveal: "M350 354H500", at: 0 },
  { id: "laptop", d: "M500 361H350", reveal: "M350 361H500", at: 80 },
  { id: "gaming", d: "M500 354H602V340", reveal: "M602 340V354H500", at: 160 },
  { id: "iphone", d: "M500 382H650", reveal: "M650 382H500", at: 240 },
  { id: "oldpc", d: "M500 375H650", reveal: "M650 375H500", at: 320 },
];

export function KitchenDrawingNarrow({ uid }: { uid: string }) {
  return (
    <svg
      viewBox="350 340 300 260"
      className="k-svg k-svg-narrow"
      fill="none"
      role="img"
      aria-label="Drawing: the box on the kitchen counter beside the microwave, a little smaller than it, with a cable from every other computer in the house running into it. Its cable to the internet is broken, and its status light is still on."
    >
      <defs>
        {RUNS.map((r) => (
          <mask key={r.id} id={`${uid}-n-${r.id}`} maskUnits="userSpaceOnUse" x="350" y="340" width="300" height="260">
            <path
              className="k-reveal m-draw"
              d={r.reveal}
              pathLength={1}
              style={{ ["--at" as string]: `${r.at}ms`, ["--for" as string]: "300ms" }}
            />
          </mask>
        ))}
        <mask id={`${uid}-n-riser`} maskUnits="userSpaceOnUse" x="350" y="340" width="300" height="260">
          <path
            className="k-reveal m-draw"
            d={RISER}
            pathLength={1}
            style={{ ["--at" as string]: "300ms", ["--for" as string]: "240ms" }}
          />
        </mask>
        <mask id={`${uid}-n-gap`} maskUnits="userSpaceOnUse" x="350" y="340" width="300" height="260">
          <rect x="350" y="340" width="300" height="260" fill="#fff" />
          <rect className="k-gap" x="596" y="562" width="24" height="20" fill="#000" />
        </mask>
      </defs>

      <path className="k-f" d="M360 340V548M640 340V548M372 478V548H628V478M457 478V548M543 478V548M372 492H628" />
      <g className="k-dots">
        {[434, 440, 446, 452].flatMap((y) =>
          [452, 457.5, 463].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
        )}
      </g>

      {RUNS.map((r) => (
        <path key={r.id} className="k-run" d={r.d} mask={`url(#${uid}-n-${r.id})`} />
      ))}
      <path className="k-trunk" d={RISER} mask={`url(#${uid}-n-riser)`} />

      <path className="k-s" d="M350 548H650M366 470H634V478H366ZM446 424V464M590 401V393M590 401L596 404" />
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
