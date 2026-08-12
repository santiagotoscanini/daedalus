/** Designed low-fi mock UIs for the four views — intentional compositions,
 * not generic skeletons, shown until real screenshots exist. Pure SVG on a
 * 640×400 canvas, text-free, tinted with the app's status colors. */

import type { ReactNode } from "react";

const INK = {
  bar: "#1d1d22",
  barSoft: "#17171c",
  line: "rgba(255,255,255,0.06)",
  accent: "#e2795a",
  blue: "#4493f8",
  amber: "#d9a441",
  red: "#e05252",
  purple: "#a78bfa",
  green: "#4ea87a",
  grey: "#6e7681",
};

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 640 400"
      preserveAspectRatio="xMidYMid slice"
      className="size-full"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Deploys: a timeline of builds per app — one row just went green. */
export function MockDeploys() {
  const rows: Array<{
    y: number;
    label: number;
    dot: string;
    bars: Array<{ x: number; w: number; c?: string; live?: boolean }>;
  }> = [
    { y: 78, label: 74, dot: INK.green, bars: [{ x: 230, w: 92 }, { x: 338, w: 60 }, { x: 414, w: 118, c: INK.green, live: true }] },
    { y: 130, label: 88, dot: INK.green, bars: [{ x: 230, w: 70 }, { x: 316, w: 108 }, { x: 440, w: 64 }] },
    { y: 182, label: 60, dot: INK.grey, bars: [{ x: 230, w: 126 }, { x: 372, w: 84 }] },
    { y: 234, label: 96, dot: INK.green, bars: [{ x: 230, w: 56 }, { x: 302, w: 88 }, { x: 406, w: 96 }] },
    { y: 286, label: 78, dot: INK.red, bars: [{ x: 230, w: 104 }, { x: 350, w: 74, c: INK.red }] },
    { y: 338, label: 84, dot: INK.green, bars: [{ x: 230, w: 82 }, { x: 328, w: 118 }] },
  ];
  return (
    <Frame>
      {/* header + time gridlines */}
      <rect x="28" y="26" width="130" height="9" rx="4.5" fill={INK.bar} />
      <line x1="200" y1="0" x2="200" y2="400" stroke={INK.line} />
      {[300, 400, 500, 600].map((x) => (
        <line key={x} x1={x} y1="56" x2={x} y2="376" stroke={INK.line} strokeDasharray="2 6" />
      ))}
      {rows.map((r) => (
        <g key={r.y}>
          {r.bars.some((b) => b.live) && (
            <rect
              x="16"
              y={r.y - 17}
              width="608"
              height="42"
              rx="9"
              fill="rgba(78,168,122,0.05)"
              stroke="rgba(78,168,122,0.35)"
            />
          )}
          <circle cx="38" cy={r.y + 4} r="3.5" fill={r.dot} opacity="0.9" />
          <rect x="54" y={r.y} width={r.label} height="8" rx="4" fill={INK.bar} />
          {r.bars.map((b) => (
            <rect
              key={b.x}
              x={b.x}
              y={r.y - 1}
              width={b.w}
              height="10"
              rx="5"
              fill={b.c ?? INK.bar}
              opacity={b.c ? 0.85 : 1}
            />
          ))}
          {r.bars.map(
            (b) =>
              b.live && (
                <circle key={`d-${b.x}`} cx={b.x + b.w + 14} cy={r.y + 4} r="4" fill={INK.green}>
                  <animate
                    attributeName="opacity"
                    values="1;0.35;1"
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              ),
          )}
        </g>
      ))}
    </Frame>
  );
}

/** Monitoring: a board of probes — green across the board except one tile
 * that is honestly UNKNOWN (grey, dashed), not painted healthy. */
export function MockMonitoring() {
  const tiles = [
    { x: 28, y: 56, c: INK.green },
    { x: 232, y: 56, c: INK.green },
    { x: 436, y: 56, c: INK.amber },
    { x: 28, y: 176, c: INK.green },
    { x: 232, y: 176, c: INK.grey, unknown: true },
    { x: 436, y: 176, c: INK.green },
  ];
  const spark = "M0 26 L14 22 L28 24 L42 14 L56 18 L70 10 L84 16 L98 8 L112 12 L126 6";
  return (
    <Frame>
      <rect x="28" y="22" width="150" height="9" rx="4.5" fill={INK.bar} />
      {tiles.map((t) => (
        <g key={`${t.x}-${t.y}`} transform={`translate(${t.x} ${t.y})`}>
          <rect
            width="176"
            height="100"
            rx="10"
            fill="rgba(255,255,255,0.02)"
            stroke={t.unknown ? "rgba(255,255,255,0.12)" : INK.line}
            strokeDasharray={t.unknown ? "4 4" : undefined}
          />
          <circle cx="22" cy="24" r="4" fill={t.c} opacity={t.unknown ? 0.6 : 0.9} />
          <rect x="36" y="20" width={t.unknown ? 54 : 72} height="8" rx="4" fill={INK.bar} />
          {t.unknown ? (
            // no data drawn for a dead probe — a flat dashed baseline, not a
            // reassuring green curve
            <line
              x1="24"
              y1="70"
              x2="152"
              y2="70"
              stroke={INK.grey}
              strokeOpacity="0.5"
              strokeDasharray="3 5"
            />
          ) : (
            <path
              d={spark}
              transform="translate(24 52)"
              fill="none"
              stroke={t.c}
              strokeOpacity="0.7"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </g>
      ))}
      {/* footer strip: uptime cells, one gap where the unknown tile is */}
      {Array.from({ length: 24 }, (_, i) => (
        <rect
          key={i}
          x={28 + i * 25}
          y="332"
          width="17"
          height="24"
          rx="3"
          fill={i === 13 || i === 14 ? "rgba(255,255,255,0.05)" : INK.green}
          opacity={i === 13 || i === 14 ? 1 : 0.55}
        />
      ))}
    </Frame>
  );
}

/** Isolation: the app's pane and the host's pane, joined only by a narrow
 * file-drop bridge — a single small payload crossing, watched from above. */
export function MockIsolation() {
  return (
    <Frame>
      {/* app pane (left, ember-tinted) */}
      <rect x="24" y="40" width="230" height="320" rx="12" fill="rgba(226,121,90,0.03)" stroke="rgba(226,121,90,0.3)" />
      <circle cx="48" cy="68" r="4" fill={INK.accent} opacity="0.9" />
      <rect x="62" y="64" width="88" height="8" rx="4" fill={INK.bar} />
      {[100, 124, 148, 172].map((y) => (
        <rect key={y} x="44" y={y} width={y === 148 ? 130 : 176} height="7" rx="3.5" fill={INK.barSoft} />
      ))}
      <rect x="44" y="300" width="110" height="26" rx="8" fill="rgba(226,121,90,0.12)" stroke="rgba(226,121,90,0.45)" />
      {/* host pane (right, neutral) */}
      <rect x="386" y="40" width="230" height="320" rx="12" fill="rgba(255,255,255,0.02)" stroke={INK.line} />
      <circle cx="410" cy="68" r="4" fill={INK.grey} />
      <rect x="424" y="64" width="72" height="8" rx="4" fill={INK.bar} />
      {[100, 124, 148, 172, 196].map((y) => (
        <rect key={y} x="406" y={y} width={y === 124 ? 150 : 186} height="7" rx="3.5" fill={INK.barSoft} />
      ))}
      {/* the bridge: one narrow path, one payload */}
      <line x1="254" y1="200" x2="386" y2="200" stroke="rgba(68,147,248,0.45)" strokeDasharray="3 6" />
      <rect x="298" y="186" width="44" height="28" rx="6" fill="rgba(68,147,248,0.12)" stroke="rgba(68,147,248,0.55)" />
      <rect x="306" y="196" width="28" height="3" rx="1.5" fill={INK.blue} opacity="0.7" />
      <rect x="306" y="203" width="20" height="3" rx="1.5" fill={INK.blue} opacity="0.45" />
      {/* the watcher above the bridge */}
      <circle cx="320" cy="140" r="5" fill="none" stroke={INK.blue} strokeOpacity="0.7" />
      <circle cx="320" cy="140" r="1.8" fill={INK.blue} />
      <path d="M320 148 L320 178" stroke="rgba(68,147,248,0.35)" />
      {/* everything else is walled off */}
      <path d="M254 100 L268 100 M254 300 L268 300 M372 100 L386 100 M372 300 L386 300" stroke={INK.line} strokeWidth="6" />
    </Frame>
  );
}

/** Recovery: the repo column re-materializing the machine column — a diff
 * whose adds light up, with the one ember hunk being applied. */
export function MockRecovery() {
  const lines: Array<{ y: number; w: number; kind?: "add" | "del" | "hunk" }> = [
    { y: 48, w: 300 },
    { y: 72, w: 260 },
    { y: 96, w: 220, kind: "hunk" },
    { y: 120, w: 280, kind: "del" },
    { y: 144, w: 310, kind: "add" },
    { y: 168, w: 240, kind: "add" },
    { y: 192, w: 290 },
    { y: 216, w: 200 },
    { y: 240, w: 270, kind: "del" },
    { y: 264, w: 290, kind: "add" },
    { y: 288, w: 250 },
    { y: 312, w: 300 },
    { y: 336, w: 180 },
  ];
  return (
    <Frame>
      <line x1="64" y1="0" x2="64" y2="400" stroke={INK.line} />
      {lines.map((l) => (
        <g key={l.y}>
          {l.kind && l.kind !== "hunk" && (
            <rect
              x="66"
              y={l.y - 7}
              width="360"
              height="22"
              fill={l.kind === "add" ? "rgba(78,168,122,0.07)" : "rgba(224,82,82,0.06)"}
            />
          )}
          {l.kind === "hunk" && (
            <rect x="66" y={l.y - 7} width="360" height="22" fill="rgba(226,121,90,0.07)" />
          )}
          <rect x="28" y={l.y} width="18" height="8" rx="4" fill={INK.barSoft} />
          <rect
            x="86"
            y={l.y}
            width={l.w}
            height="8"
            rx="4"
            fill={
              l.kind === "add"
                ? "#26493a"
                : l.kind === "del"
                  ? "#482a2a"
                  : l.kind === "hunk"
                    ? "#4d3128"
                    : INK.bar
            }
          />
        </g>
      ))}
      {/* the converge card: repo → machine, one key */}
      <g>
        <rect
          x="446"
          y="118"
          width="166"
          height="128"
          rx="10"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(226,121,90,0.35)"
        />
        <rect x="464" y="140" width="56" height="38" rx="6" fill="rgba(255,255,255,0.03)" stroke={INK.line} />
        <rect x="540" y="140" width="56" height="38" rx="6" fill="rgba(226,121,90,0.1)" stroke="rgba(226,121,90,0.5)" />
        <path d="M524 159 L536 159 M531 154 L536 159 L531 164" stroke={INK.accent} strokeOpacity="0.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {/* the one key */}
        <circle cx="476" cy="212" r="6" fill="none" stroke={INK.amber} strokeOpacity="0.8" />
        <path d="M482 212 L500 212 M494 212 L494 218" stroke={INK.amber} strokeOpacity="0.8" strokeLinecap="round" />
        <rect x="512" y="206" width="84" height="8" rx="4" fill={INK.barSoft} />
        <path d="M446 176 L426 168" stroke="rgba(226,121,90,0.35)" />
      </g>
    </Frame>
  );
}

export function MockView({ view }: { view: string }) {
  switch (view) {
    case "deploys":
      return <MockDeploys />;
    case "monitoring":
      return <MockMonitoring />;
    case "isolation":
      return <MockIsolation />;
    default:
      return <MockRecovery />;
  }
}
