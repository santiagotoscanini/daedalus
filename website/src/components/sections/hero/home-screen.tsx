/** Grandma's Home Screen, the first two layers of Phone B: her wallpaper and apps (layer 1) and the
 * TestFlight notification that drops over them (layer 2). Pinch then installs into the first empty
 * slot, in row three, high on the screen so the tap, the ring and the open all happen where a
 * reader who sees only the top of her phone is looking: the ring fills under a veil and its label
 * turns from "Loading…" to Pinch with TestFlight's orange beta dot.
 *
 * Her other apps are left anonymous on purpose (no real company's icon belongs on her phone): plain
 * squircles in warm tints with blank labels, all slightly out of focus, so the eye lands on the one
 * sharp thing, Pinch. The grid is iOS's at this scale: four 48px columns 22.5 in from the edges, a
 * 72px row pitch, a 2x2 widget top left, a wide one (her photos) in rows 3-4 and one more row of
 * apps under it, so the screen is furnished down to the Search pill. The final frame (prerender,
 * reduced motion, no-JS) is the installed icon, the notification gone. Styles:
 * styles/landing/hero.css, `.home*`. */

import type { CSSProperties } from "react";
import { AppIcon } from "~/components/landing/app-icon";

/** The grid: column x (71 apart, half pixels, so every edge is whole at 2x) and row y. */
const COL = (c: number) => 22.5 + 71 * c;
const ROW = (r: number) => 62 + 72 * r;

/** Her apps: rows 0-1 right of the widget, row 2 left of Pinch's slot (row 2, column 2; hero.css
 * opens the app out of the same square), row 5 under her photos. [row, column, tint, label width] */
const TILES: readonly [number, number, string, number][] = [
  [0, 2, "#E7D6C3", 22], [0, 3, "#D9E1D4", 30], [1, 2, "#D6DCE6", 18], [1, 3, "#E9D3CF", 26],
  [2, 0, "#DDD5E6", 24], [2, 1, "#E4DCC8", 20],
  [5, 0, "#D3E0E0", 28], [5, 1, "#E6CFC2", 16], [5, 2, "#D8D8DE", 22], [5, 3, "#E2E0D2", 30],
];
const SLOT = { row: 2, col: 2 };
const DOCK = ["#E6CFC2", "#D6DCE6", "#D9E1D4", "#DDD5E6"];

const px = (n: number) => `${n}px`;

function Tile({ x, y, fill, label }: { x: number; y: number; fill: string; label?: number }) {
  return (
    <>
      <span className="home-tile" style={{ left: px(x), top: px(y), "--fill": fill } as CSSProperties} />
      {label != null && (
        <span className="home-label" style={{ left: px(x + 24 - label / 2), top: px(y + 54), width: px(label) }} />
      )}
    </>
  );
}

export function HomeScreen() {
  return (
    <div className="home">
      <div className="home-layer">
        {/* one filter for the whole out-of-focus plane */}
        <div className="home-soft">
          {/* a widget, out of focus: a date and two lines of whatever it shows */}
          <span className="home-widget">
            <i />
            <i />
            <i />
            <i />
          </span>
          {TILES.map(([r, c, fill, label]) => (
            <Tile key={`${r}-${c}`} x={COL(c)} y={ROW(r)} fill={fill} label={label} />
          ))}
          {/* rows 3-4: a photo widget, a warm picture too soft to make out */}
          <span className="home-photos" style={{ top: px(ROW(3)) }} />
          <span className="home-search">
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
              <circle cx="3.75" cy="3.75" r="2.9" stroke="currentColor" strokeWidth="1.3" />
              <path d="m5.9 5.9 2.35 2.35" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            Search
          </span>
          <span className="home-dock">
            {DOCK.map((fill, i) => (
              <Tile key={fill} x={COL(i) - 9} y={14} fill={fill} />
            ))}
          </span>
        </div>

        <span className="home-pinch" style={{ left: px(COL(SLOT.col)), top: px(ROW(SLOT.row)) }}>
          <span className="home-pinch-icon">
            <AppIcon app="pinch" size={48} />
            <span className="home-veil">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="12" r="10" stroke="#fff" strokeOpacity=".95" strokeWidth="1.6" />
                {/* the pie: a stroke as wide as its radius, drawn round from twelve o'clock */}
                <circle
                  className="home-pie"
                  cx="12"
                  cy="12"
                  r="3.75"
                  stroke="#fff"
                  strokeOpacity=".95"
                  strokeWidth="7.5"
                  pathLength={1}
                  transform="rotate(-90 12 12)"
                />
              </svg>
            </span>
          </span>
          <span className="home-pinch-label">
            <span className="home-loading">Loading…</span>
            <span className="home-installed">
              <i />
              Pinch
            </span>
          </span>
        </span>
      </div>

      <div className="home-banner">
        <span className="home-banner-icon" />
        {/* the app's name and the time share a baseline, as iOS sets them */}
        <span className="home-banner-head">
          <span className="home-banner-title">TestFlight</span>
          <span className="home-banner-time">now</span>
        </span>
        <span className="home-banner-body">Pinch is ready to test.</span>
      </div>
    </div>
  );
}
