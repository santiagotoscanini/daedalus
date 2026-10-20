/** The kitchen, wide: a doll's-house cutaway in the manifesto's FIG. 2 ink. The kitchen is the
 * middle room, so the box on its counter sits on the page axis, a little smaller than the microwave
 * beside it, and a dashed run comes to it from every other machine in the house. The five runs end
 * on one solid riser in the wall above the box, which goes down into it: five dashed lines entering
 * the subject side by side read as a barcode, one line reads as its cable.
 * Its cable to the internet is broken and its light is still on: the paragraph's claim about
 * outages, in one picture. The light is the figure's only green.
 *
 * Each machine is a button that names itself; pointing at one (or at its mark), focusing it or
 * tapping it lights its run, its way down the riser into the box, and its strokes,
 * and the readout under the drawing (kitchen.tsx) says what it does. At rest the five marks'
 * discs are a little brighter than the drawing's hidden lines and the pointer is a hand over a
 * machine: the only cue that they answer, since no sentence asks anyone to point.
 *
 * The inks are the page's drawing tokens mixed opaque against the page colour (kitchen.css), so a
 * line crossing or standing on another never shows a brighter knot where two translucent strokes
 * overlap. Layer order does the rest: hidden lines, then the runs, then structure over them (a run
 * passes behind the attic floor), then the machines, the box last.
 *
 * Pixel grid: wherever the column is 928px or more the drawing is 1:1 (a narrower column crops its
 * ends: kitchen.css), so everything sits half a unit off the whole numbers it is written in (one
 * translate), which puts every 1px line on a pixel row at 1x and 2x alike. The box's 1.5px outline
 * is drawn a quarter unit inside its 45-unit square, and each focus ring's 1.5px a quarter unit
 * off its whole number, so at 2x they cover exactly three device pixels. The internet cable and its
 * label end 16 units short of the house's eave so that the longest crop (928 wide, x 36 to 964)
 * still holds the whole word. All geometry is literal. */

import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
import { MARKS } from "~/components/marks";
import { LIST_ORDER, MACHINES, type MachineId, readout } from "./machines";

export interface MachineHandlers {
  onPointerEnter: (e: PointerEvent<SVGGElement>) => void;
  onPointerLeave: (e: PointerEvent<SVGGElement>) => void;
  onPointerDown: (e: PointerEvent<SVGGElement>) => void;
  onFocus: (e: FocusEvent<SVGGElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<SVGGElement>) => void;
}

/** A run's dashes, as one list written out for its whole length. Every run starts on the riser with
 * a whole dash, so two runs side by side leave it in phase; its turn lands in the middle of a dash;
 * and its last dash ends on the machine. To fit, the gaps are stretched or squeezed a little (g, g2:
 * never more than a third of a unit off 3): `n` gaps of `g` along the horizontal to the dash that
 * turns, then `m` gaps of `g2` to the machine. */
function dashes(n: number, g: number, m: number, g2: number): string {
  const out: number[] = [4];
  for (let i = 0; i < n; i++) out.push(g, 4);
  for (let i = 0; i < m; i++) out.push(g2, 4);
  out.push(7); // an even count, so the list never repeats inverted
  return out.join(" ");
}

/** The riser: one solid line on the page axis, from the highest run down into the box's top. Every
 * run ends on it, so the box receives a single cable. */
export const RISER = "M500 354V426";

/** One run per machine, from the riser to the machine (so its dashes start there): across, then up
 * or down to it. The two from the left join the riser at 354 and 361, the three from the right at
 * 354, 375 and 382, the dash's own 7-unit rhythm, nested so that none crosses another. `tail` is the
 * rest of the machine's way to the box, down the riser, lit with the run; it starts half a unit
 * above the run, so the lit corner is square. `reveal` is the run the other way round, for the mask
 * that draws it in from the machine to the riser. They are drawn in this order, the two rooms left
 * of the kitchen, then upstairs, then the two to its right; `at` is when each reveal starts (ms
 * after the figure plays). */
export const RUNS: readonly {
  id: Exclude<MachineId, "box">;
  d: string;
  tail: string;
  reveal: string;
  dash: string;
  at: number;
}[] = [
  {
    id: "macbook",
    d: "M500 354H174V451",
    tail: "M500 353.5V426",
    reveal: "M174 451V354H500",
    dash: dashes(46, 3.0435, 14, 2.7857),
    at: 0,
  },
  {
    id: "laptop",
    d: "M500 361H275V455",
    tail: "M500 360.5V426",
    reveal: "M275 455V361H500",
    dash: dashes(32, 2.96875, 13, 3.0769),
    at: 80,
  },
  {
    id: "gaming",
    d: "M500 354H602V330",
    tail: "M500 353.5V426",
    reveal: "M602 330V354H500",
    dash: dashes(14, 3.1429, 3, 3.3333),
    at: 160,
  },
  {
    id: "iphone",
    d: "M500 382H736V488",
    tail: "M500 381.5V426",
    reveal: "M736 488V382H500",
    dash: dashes(33, 3.0909, 15, 2.9333),
    at: 240,
  },
  {
    id: "oldpc",
    d: "M500 375H831V454",
    tail: "M500 374.5V426",
    reveal: "M831 454V375H500",
    dash: dashes(47, 3, 11, 3),
    at: 320,
  },
];

/** Each machine's mark: a page-coloured disc on its run, and the brand mark scaled into it. The
 * apple and the penguin are 12 units; the Windows square is 9.6, because a square reads larger than
 * the other two at the same size, and at 12 its corners would touch the disc's rim. */
type MarkAt = { os: "apple" | "windows" | "linux"; x: number; y: number; fit: string };
const MARK: Record<Exclude<MachineId, "box">, MarkAt> = {
  macbook: { os: "apple", x: 174, y: 414, fit: "translate(168 408) scale(.5)" },
  laptop: { os: "windows", x: 275, y: 414, fit: "translate(270.2 409.2) scale(.4)" },
  gaming: { os: "windows", x: 560, y: 354, fit: "translate(555.2 349.2) scale(.4)" },
  oldpc: { os: "linux", x: 831, y: 393, fit: "translate(825 387) scale(.5)" },
  iphone: { os: "apple", x: 736, y: 440, fit: "translate(730 434) scale(.5)" },
};

/** Each machine's hit area: the machine itself padded 12, x y w h. Its mark's disc is a second
 * one, so pointing at the logo works too. The runs take no pointer: near the riser they lie 7
 * units apart, and a padded run would steal the pointer from its neighbour. */
const HIT: Record<MachineId, readonly [number, number, number, number]> = {
  box: [466, 414, 68, 68],
  macbook: [134, 439, 80, 60],
  laptop: [238, 443, 74, 56],
  gaming: [570, 258, 64, 84],
  oldpc: [794, 442, 74, 40],
  iphone: [716, 475, 38, 44],
};

function HitArea({ id }: { id: MachineId }) {
  const [x, y, w, h] = HIT[id];
  return (
    <>
      <rect className="k-hit" x={x} y={y} width={w} height={h} />
      {id !== "box" && <circle className="k-hit" cx={MARK[id].x} cy={MARK[id].y} r="14" />}
    </>
  );
}

/** The keyboard focus ring: 1.5px, ink-1 at 70%, round the machine itself (not its mark, which sits
 * 40 units off) and 4 clear of its outline, with a 6-unit corner (the MacBook's is 3 clear on the
 * side the lamp leans in from). A machine that stands on a desk, the attic floor or a shelf has its
 * ring open at the bottom and ending on that surface's top edge, so it never thickens the surface's
 * line; the box's does the same on its counter, 2.5 clear. The iPhone lies in the sofa, so its ring
 * is closed. Under the ring goes a page-coloured plate (RingBack, drawn before the machine): it
 * cuts the lines the ring crosses, as a label's halo does, and clears the room's own lines from
 * inside it (the sofa's seams round the phone), so nothing makes a brighter knot or a second edge. */
const RING: Record<MachineId, string> = {
  box: "M474 469.5V426Q474 422 478 422H522Q526 422 526 426V469.5",
  macbook: "M141.75 486.5V452.75A6 6 0 0 1 147.75 446.75H198.75A6 6 0 0 1 204.75 452.75V486.5",
  laptop: "M245.75 486.5V456.75A6 6 0 0 1 251.75 450.75H297.75A6 6 0 0 1 303.75 456.75V486.5",
  gaming: "M577.75 329.5V271.75A6 6 0 0 1 583.75 265.75H619.75A6 6 0 0 1 625.75 271.75V329.5",
  oldpc: "M801.75 469.5V455.75A6 6 0 0 1 807.75 449.75H853.75A6 6 0 0 1 859.75 455.75V469.5",
  iphone:
    "M729.25 481.75H741.25A6 6 0 0 1 747.25 487.75V505.75A6 6 0 0 1 741.25 511.75H729.25A6 6 0 0 1 723.25 505.75V487.75A6 6 0 0 1 729.25 481.75Z",
};

function RingBack({ id }: { id: MachineId }) {
  return <path className="k-ring-back" d={RING[id]} />;
}

function Ring({ id }: { id: MachineId }) {
  return <path className="k-ring" d={RING[id]} />;
}

/** Each machine's own drawing: its structure (`s`) and its hidden lines (`f`, the graphics card). */
function MachineArt({ id }: { id: Exclude<MachineId, "box"> }) {
  switch (id) {
    case "macbook":
      return (
        <g className="k-ms">
          <rect x="150" y="451" width="48" height="32" rx="3" />
          <rect x="146" y="483" width="56" height="4" rx="1.5" />
        </g>
      );
    case "laptop":
      return (
        <g className="k-ms">
          <rect x="254" y="455" width="42" height="28" rx="1.5" />
          <rect x="250" y="483" width="50" height="4" rx="1" />
        </g>
      );
    case "gaming":
      return (
        <>
          <g className="k-mf" strokeDasharray="3 2">
            <rect x="586" y="296" width="32" height="16" />
            <circle cx="595" cy="304" r="5" />
            <circle cx="609" cy="304" r="5" />
          </g>
          <g className="k-ms">
            <rect x="582" y="270" width="40" height="60" rx="2" />
            <path d="M590 278H614" />
          </g>
        </>
      );
    case "oldpc":
      return (
        <>
          <g className="k-ms">
            <rect x="806" y="454" width="50" height="16" rx="1.5" />
          </g>
          <path className="k-mf" d="M812 460H826" />
        </>
      );
    case "iphone":
      return (
        <g className="k-ms">
          <rect x="730.5" y="488" width="9" height="18" rx="2.2" transform="rotate(-16 735 497)" />
        </g>
      );
  }
}

export function KitchenDrawing({
  uid,
  active,
  bind,
}: {
  uid: string;
  active: MachineId | null;
  bind: (id: MachineId) => MachineHandlers;
}) {
  // pointing at the box lights every run: everything in the house comes to it
  const lit = (id: MachineId) => active === id || (active === "box" && id !== "box");

  return (
    <svg
      viewBox="0 84 1000 524"
      className="k-svg k-svg-wide"
      fill="none"
      role="group"
      aria-label="Drawing: a house in cutaway. The box sits on the kitchen counter beside the microwave, a little smaller than it, and a cable runs to it from every other computer in the house. Its cable to the internet is broken, and its status light is still on."
    >
      <defs>
        {/* each dashed run is revealed by a solid copy of itself drawn from the machine to the riser */}
        {RUNS.map((r) => (
          <mask key={r.id} id={`${uid}-r-${r.id}`} maskUnits="userSpaceOnUse" x="0" y="84" width="1000" height="524">
            <path
              className="k-reveal m-draw"
              d={r.reveal}
              pathLength={1}
              style={{ ["--at" as string]: `${r.at}ms`, ["--for" as string]: "300ms" }}
            />
          </mask>
        ))}
        {/* the riser, drawn down into the box as the first run reaches it */}
        <mask id={`${uid}-riser`} maskUnits="userSpaceOnUse" x="0" y="84" width="1000" height="524">
          <path
            className="k-reveal m-draw"
            d={RISER}
            pathLength={1}
            style={{ ["--at" as string]: "300ms", ["--for" as string]: "240ms" }}
          />
        </mask>
        {/* the break in the internet cable: a 32-unit gap opened from its centre */}
        <mask id={`${uid}-gap`} maskUnits="userSpaceOnUse" x="0" y="84" width="1000" height="524">
          <rect x="0" y="84" width="1000" height="524" fill="#fff" />
          <rect className="k-gap" x="842" y="562" width="32" height="20" fill="#000" />
        </mask>
      </defs>

      <g transform="translate(.5 .5)">
        <g aria-hidden="true">
          {/* hidden and construction lines: interior walls, knee walls, cabinets, books, towels */}
          <path
            className="k-f"
            d="M240 338V548M360 338V548M640 338V548M790 338V548M280 330V233M720 330V233M372 478V548H628V478M457 478V548M543 478V548M372 492H628M802 420V409H822V420M806 409V416M860 420V411H880V420M864 411V417"
          />
          <path className="k-f" strokeWidth="4" d="M306 392V372M313 392V368M320 392V374M327 392V370" />
          <g className="k-dots">
            {[434, 440, 446, 452].flatMap((y) =>
              [452, 457.5, 463].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
            )}
          </g>

          {/* the runs, under the structure they pass through; the riser draws down into the box as the
              first run reaches it; each machine's way on to the box lies over it, lit with its run */}
          {RUNS.map((r) => (
            <path
              key={r.id}
              className="k-run"
              d={r.d}
              strokeDasharray={r.dash}
              mask={`url(#${uid}-r-${r.id})`}
              data-on={lit(r.id) || undefined}
            />
          ))}
          <path className="k-trunk" d={RISER} mask={`url(#${uid}-riser)`} />
          {RUNS.map((r) => (
            <path key={r.id} className="k-tail" d={r.tail} data-on={lit(r.id) || undefined} />
          ))}

          {/* the house, its rooms and their furniture */}
          <path
            className="k-s"
            d="M30 548H970M110 548V330H90L500 96L910 330H890V548M110 330H890M110 338H890M110 330L500 107.5L890 330M236 246.7V196H262V231.8M232 196H266M500 168V212M470 190H530M300 330V312H420V330M300 318H420M462 272H560M468 272V330M554 272V330M512 268V272M128 487H222M128 492H222M134 492V548M216 492V548M214 487L208 462L220 452M214 448L226 456M300 392H354M248 487H350M248 492H350M254 492V548M344 492V548M322 487V471H332V487M332 474A5 5 0 0 1 332 484M366 470H634V478H366ZM446 424V464M590 401V393M590 401L596 404M660 548V500Q660 492 668 492H678Q686 492 686 500V548M744 548V500Q744 492 752 492H762Q770 492 770 500V548M686 506V482Q686 474 694 474H736Q744 474 744 482V506M686 506H744M686 520H744M796 420H884M796 470H884"
          />
          <g className="k-s">
            <rect x="470" y="168" width="60" height="44" rx="2" />
            <rect x="306" y="304" width="30" height="8" rx="4" />
            <rect x="480" y="230" width="64" height="38" rx="2" />
            <rect x="124" y="380" width="32" height="24" />
            <rect x="380" y="418" width="88" height="52" rx="4" />
            <rect x="388" y="426" width="50" height="36" rx="3" />
            <circle cx="590" cy="401" r="12" />
            <rect x="690" y="394" width="40" height="28" />
          </g>
          <path className="k-s" strokeLinecap="round" d="M406 486H422M492 486H508M577 486H593" />

          {/* The internet, drawn whole and broken by the mask. It drops through the counter, runs
              along the counter's underside (on its line, so no third line shows inside it) to the
              cabinets' divider and goes down that seam, so it never crosses a cabinet door; the
              ticks cross exactly at the break's two ends. */}
          <path className="k-s" d="M516 470V478H543V572H894" mask={`url(#${uid}-gap)`} />
          <path
            className="k-s m-fade"
            d="M838 577L846 567M870 577L878 567"
            style={{ ["--at" as string]: "1350ms", ["--for" as string]: "200ms" }}
          />
        </g>

        {/* The machines, in the phone list's order so the keyboard meets them as the list reads: the
            box, then the house from the study round to the living room. The box's own drawing comes
            after all of them (below), so the riser ends under it; its button here
            is the hit area and the ring, and the drawing lets the pointer through to it. */}
        {LIST_ORDER.map((id) => {
          if (id === "box") {
            return (
              <g
                key={id}
                className="k-mach"
                role="button"
                tabIndex={0}
                aria-label={readout(MACHINES.box)}
                data-on={active === "box" || undefined}
                {...bind("box")}
              >
                <HitArea id="box" />
                <RingBack id="box" />
                <Ring id="box" />
              </g>
            );
          }
          const mark = MARK[id];
          return (
            <g
              key={id}
              className="k-mach"
              role="button"
              tabIndex={0}
              aria-label={readout(MACHINES[id])}
              data-on={active === id || undefined}
              {...bind(id)}
            >
              <HitArea id={id} />
              <RingBack id={id} />
              <MachineArt id={id} />
              <circle className="k-disc" cx={mark.x} cy={mark.y} r="9" />
              {/* even-odd, so a mark drawn with a cut-out (the penguin's belly) keeps it */}
              <path className="k-mark" d={MARKS[mark.os]} fillRule="evenodd" transform={mark.fit} />
              <Ring id={id} />
            </g>
          );
        })}

        {/* the box, the drawing's subject: its outline covers 477.5 to 522.5 across and 425.5 to
            470.5 down, so it stands on the counter's top line and the riser ends under it */}
        <g aria-hidden="true" className="k-box">
          <rect className="k-body" x="478.25" y="426.25" width="43.5" height="43.5" />
          <path className="k-f" d="M484 433H516M484 436H516M484 439H516M484 442H516M484 445H516" />
          <circle cx="508" cy="462" r="2.4" fill="var(--color-ok)" />
          <path className="k-s" strokeLinecap="round" d="M513.4 459.9A3 3 0 1 0 517.6 459.9M515.5 458.2V462" />
        </g>

        <g aria-hidden="true" className="k-labels">
          <text className="fig-label" x="902" y="576">
            internet
          </text>
          {/* clear of the box's focus ring by 6 */}
          <text
            className="fig-label m-fade k-still"
            x="534"
            y="466"
            style={{ ["--at" as string]: "1600ms", ["--for" as string]: "300ms" }}
          >
            still on
          </text>
          <text className="fig-label" x="380" y="296" textAnchor="middle">
            upstairs
          </text>
          {(
            [
              [175, "study"],
              [300, "home office"],
              [500, "kitchen"],
              [715, "living room"],
              [840, "closet"],
            ] as const
          ).map(([x, t]) => (
            <text key={t} className="fig-label" x={x} y="596" textAnchor="middle">
              {t}
            </text>
          ))}
        </g>
      </g>
    </svg>
  );
}
