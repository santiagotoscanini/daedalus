/** The tree, narrow (containers under 920px): the same run, stood on end so it reads down a phone.
 * The axis runs down the left from your request at the top; each question's options fan out
 * sideways, and the nine answers sit in fixed rows to the right. Here the axis keeps its length (a
 * cut folds the fan into it and nothing else moves), so every station stays level with its own row
 * and its leader is one short straight hairline: the drawing reads as an index, never as a bundle
 * of curves. The count carries the shrinking that the wide plate draws. Drawn at fixed pixels,
 * never scaled, so the type keeps its size on a phone. The end is the column's tenth line: "your
 * app" beside the open end, then the app's icon on it with its name in the same place.
 *
 * The rows are placed, not flowed, so the leaders (in the SVG) know where they end without script:
 * every answer fits one line at 358px (at 288, the narrowest phone's, they step down to 12px). The
 * first, "Face or fingerprint, one sign-in for the family", is the longest, so it holds one line from
 * 356px and breaks after its comma below that; then it sits a line higher (a two-line row is 46 tall,
 * the pitch) and its leader, the only one that bends, steps up 16 square, like the wide plate's
 * elbows. Rows 2 to 9 sit on their stations, 46 apart (a 30 row and 16 of air).
 *
 * What runs an answer ("Under the hood") is a small card under the row that was tapped, where the
 * finger is, over the rows below it until the tap is taken back. */

import { type CSSProperties, memo } from "react";

import { AppIcon } from "~/components/landing/app-icon";

import { ALL_CUT, EDGES, NARROW, NODES, frame } from "./lattice";
import {
  type Comp,
  type PlateProps,
  type Put,
  type State,
  Foot,
  GREEN,
  crisp,
  done,
  nodeAttrs,
  paintCommon,
  paintLattice,
  r2,
  rowProps,
} from "./plate";
import { COLUMNS, HOUSE_KEEP, REQUESTS, WHERE, WHO } from "./requests";

const AXIS = NARROW.cross;
/** The rows' text starts here. */
const GUTTER = 84;
/** Leaders end 8 short of the words: a focused row's ring (4 of padding, 1 of offset, its 2px line)
 * then stops a pixel short of its own leader. */
const TIP = GUTTER - 8;
/** The green path is 1.5px: on a quarter pixel past the axis it covers exactly three device pixels at
 * 2x, where one on the half pixel would cover four, two of them soft. */
const PATH_X = AXIS + 0.25;

const F = frame(ALL_CUT, [...HOUSE_KEEP, ...REQUESTS[0]!.keep], NARROW);
const D0 = done(0);
const END_Y = F.end[1];
/** Column k's station: 44.5, 90.5 … 412.5 (the axis never moves, so these hold for every frame). */
const stationY = (k: number) => F.stations[k + 1]![1];
/** A row's question (11.5/14) has its x-height centred 7.5 below the row's top: a leader lands there. */
const Q_MID = 7.5;
/** Row tops: every question level with its station. */
const ROW_TOP = COLUMNS.map((_, k) => stationY(k) - Q_MID);
/** The first row where its answer takes two lines (the narrowest phones): 16 higher, so the same 16 of
 * air sits under it as under every row. */
const WRAP_TOP = stationY(1) - Q_MID - 62;
/** The end's tenth line. The end station (458.5) is a whole unit after the last question's, so its
 * line sits where a tenth row's question would: a 13/18 line has its x-height centred 10 below its
 * top, so its words are level with the station, as each question is with its own. On the narrowest
 * phones a long label wraps downward, as row 1's answer does. */
const END_TOP = Math.round(END_Y - 10);
/** The stage ends 24 under the end station, past the icon (to 475). */
const STAGE_H = Math.ceil(END_Y + 24);

/** Column k's leader: from 6 clear of its fan's widest option, level along its station to the rows.
 * The jogged one (row 1 on the narrowest phones) steps up 16 on a crisp vertical halfway along, and
 * lands level. */
function leadD(k: number, wrapped = false): string {
  const x0 = AXIS + ((COLUMNS[k]!.n - 1) / 2) * NARROW.pitch + 6;
  const y = stationY(k);
  if (!wrapped) return `M${x0} ${y}H${TIP}`;
  return `M${x0} ${y}H${crisp((x0 + TIP) / 2)}V${WRAP_TOP + Q_MID}H${TIP}`;
}

/** Faint while its column is open; once cut, the stack's ink, or the light for the two the request
 * settled. */
function leadStroke(k: number, v: number): string {
  if (k < 7) return `rgba(255,255,255,${r2(0.14 + 0.08 * v)})`;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * v);
  return `rgba(${mix(255, 78)},${mix(255, 168)},${mix(255, 122)},${r2(0.14 + 0.41 * v)})`;
}

export function paintNarrow(c: Comp, S: State, put: Put) {
  const f = frame(S.t, S.keep, NARROW);
  paintLattice(c, f, S, put);
  c.leads.forEach((lead) => {
    const k = Number(lead.getAttribute("data-lead"));
    put(lead, "stroke", leadStroke(k, S.elbow[k]!));
    put(lead, "opacity", r2(S.head[k]!));
  });
  COLUMNS.forEach((_, k) => {
    // the question stands beside its station from the walk on; its answer arrives with the cut
    const q = c.qs[k];
    if (q) put(q, "style:opacity", S.head[k]! >= 1 ? null : r2(S.head[k]!));
    const row = c.rows[k];
    if (row) {
      const v = S.row[k]!;
      put(row, "style:opacity", v >= 1 ? null : r2(v));
      put(row, "style:transform", v >= 1 || v <= 0 ? null : `translateY(${r2(3 * (1 - v))}px)`);
    }
  });
  const icon = Math.max(...S.icon);
  c.icons.forEach((el, r) => {
    const v = S.icon[r]!;
    put(el, "style:opacity", r2(v));
    put(el, "style:transform", v >= 1 ? null : `scale(${r2(0.85 + 0.15 * v)})`);
  });
  // "your app" leaves in the first half of the icon's arrival; the end label takes its place in the
  // second (paintCommon)
  if (c.yourApp) put(c.yourApp, "style:opacity", r2(S.endA * (1 - Math.min(1, 2 * icon))));
  if (c.path) {
    put(c.path, "stroke-dashoffset", r2(1 - S.path));
    put(c.path, "opacity", r2(S.pathA));
  }
  paintCommon(c, S, put);
}

/** Row k's answer on the narrow plate: the first may break after its comma (the narrowest phones),
 * rows 8 and 9 carry where they came from. */
function Answer({ k }: { k: number }) {
  if (k >= 7)
    return (
      <>
        <span data-answer={k - 7}>{k === 7 ? WHERE[REQUESTS[0]!.keep[0]] : WHO[REQUESTS[0]!.keep[1]]}</span>{" "}
        <span className="dc-from">from your request</span>
      </>
    );
  const a = COLUMNS[k]!.a!;
  if (k > 0) return a;
  const at = a.indexOf(",") + 1;
  return (
    <>
      {a.slice(0, at)} <br className="dc-n-br" />
      {a.slice(at + 1)}
    </>
  );
}

export const PlateNarrow = memo(function PlateNarrow({ onHot, onReplay }: PlateProps) {
  return (
    <div data-comp="n" className="dc-narrow">
      <div className="dc-n-stage" style={{ height: STAGE_H, "--g": `${GUTTER}px` } as CSSProperties}>
        <svg
          width={GUTTER}
          height={STAGE_H}
          viewBox={`0 0 ${GUTTER} ${STAGE_H}`}
          className="dc-n-svg"
          fill="none"
          aria-hidden
          focusable="false"
        >
          <g stroke="var(--ink-faint)">
            {EDGES.map((e, i) => {
              const a = F.nodes[e.a]!;
              const b = F.nodes[e.b]!;
              const alpha = Math.min(nodeAttrs(F, D0, e.a, 0).alpha, nodeAttrs(F, D0, e.b, 0).alpha);
              return <line key={i} data-edge x1={a.x} y1={a.y} x2={b.x} y2={b.y} opacity={r2(alpha)} />;
            })}
          </g>
          {COLUMNS.map((_, k) => (
            <path key={k} data-lead={k} d={leadD(k)} stroke={leadStroke(k, 1)} />
          ))}
          <path data-lead={0} data-wrap="" d={leadD(0, true)} stroke={leadStroke(0, 1)} />
          <path
            data-path
            d={`M${PATH_X} ${NARROW.axis0}V${END_Y}`}
            stroke={GREEN}
            strokeWidth={1.5}
            pathLength={1}
            strokeDasharray="1 1"
            strokeDashoffset={0}
          />
          {NODES.map((_, i) => {
            const n = F.nodes[i]!;
            const a = nodeAttrs(F, D0, i, 1);
            return (
              <circle key={i} data-node cx={n.x} cy={n.y} r={a.r} fill={a.fill} stroke={a.stroke} opacity={a.opacity} />
            );
          })}
        </svg>
        {REQUESTS.map((r, i) => (
          <div
            key={r.app}
            aria-hidden
            data-icon={i}
            className="dc-n-icon"
            style={{ left: AXIS - 16, top: Math.round(END_Y) - 16, opacity: i === 0 ? 1 : 0 }}
          >
            <AppIcon app={r.app} size={32} />
          </div>
        ))}
        <div className="dc-n-rows" role="list" aria-label="The nine answers">
          {COLUMNS.map((col, k) => (
            <div
              key={k}
              role="listitem"
              className="dc-n-row"
              data-first={k === 0 ? "" : undefined}
              style={
                {
                  left: GUTTER,
                  "--top": `${ROW_TOP[k]}px`,
                  ...(k === 0 ? { "--top-wrap": `${WRAP_TOP}px` } : null),
                } as CSSProperties
              }
              {...rowProps(k, onHot)}
            >
              <span data-q={k} className="dc-n-q">
                {col.q}
              </span>
              <span data-row={k} className={k < 7 ? "dc-n-a" : "dc-n-a dc-mine"}>
                <Answer k={k} />
              </span>
              {k < 7 ? (
                <span aria-hidden data-under={k} className="dc-n-under">
                  Under the hood: {col.under}
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="dc-n-end" style={{ left: GUTTER, top: END_TOP }} aria-hidden>
          <span data-yourapp className="dc-n-yourapp" style={{ opacity: 0 }}>
            your app
          </span>
          {REQUESTS.map((r, i) => (
            <span key={r.app} data-label={i} style={i === 0 ? undefined : { opacity: 0 }}>
              {r.end}
            </span>
          ))}
        </div>
      </div>
      <Foot onReplay={onReplay} />
    </div>
  );
});
