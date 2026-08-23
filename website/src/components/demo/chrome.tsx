/** Shared chrome + leaf primitives for the demo windows: the app's real
 * shell (sidebar rail, boards, chips, sparklines) hand-rebuilt at desktop
 * density on the fixed 1280×800 canvas. Colors are the app's own tokens,
 * inlined — the demo must look like daedalus, not like this site. */

import type { ReactNode } from "react";

import { AppMark, hasAppMark } from "./app-marks";

export const APP = {
  bg: "#08080a",
  rail: "#0b0b0d",
  panel: "#111113",
  panel2: "#17171a",
  raise: "#1d1d21",
  hairline: "#1b1b1f",
  border: "#232327",
  text: "#ededef",
  muted: "#8b8b95",
  dim: "#5f5f68",
  accent: "#e2795a",
  accentDim: "#b8563a",
  ok: "#4ea87a",
  warn: "#d9a441",
  bad: "#e05252",
  info: "#5b8dd9",
} as const;

export type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "accent";

export const TONE: Record<Tone, string> = {
  ok: APP.ok,
  warn: APP.warn,
  bad: APP.bad,
  info: APP.info,
  muted: APP.dim,
  accent: APP.accent,
};

/* ---------------------------------------------------------------- *
 * Leaf pieces
 * ---------------------------------------------------------------- */

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  const c = TONE[tone];
  const halo = tone !== "muted";
  return (
    <span
      className={`inline-block size-[9px] shrink-0 rounded-full${pulse ? " demo-dot-pulse" : ""}`}
      style={{ background: c, boxShadow: halo ? `0 0 0 3px ${c}26` : undefined }}
    />
  );
}

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-[8px] py-[1px] text-[11px] leading-[1.5]"
      style={{ borderColor: `${c}66`, color: tone === "muted" ? APP.dim : c }}
    >
      {children}
    </span>
  );
}

/** Row-level sparkline: stroke only, scaled to its own band — the app
 * draws healthy services flat, not filled. */
export function Spark({
  pts,
  tone = "muted",
  w = 88,
  h = 20,
}: {
  pts: number[];
  tone?: Tone;
  w?: number;
  h?: number;
}) {
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map(
      (p, i) =>
        `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 3 - ((p - min) / span) * (h - 6)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline
        points={d}
        fill="none"
        stroke={TONE[tone]}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={tone === "muted" ? 0.7 : 0.9}
      />
    </svg>
  );
}

/** An app's icon in the list: its own mark when it ships one, and the
 * generated monogram when it does not — the same order daedalus resolves
 * them in, where the monogram is the fallback rather than the norm. */
export function AppTile({ name, size = 22 }: { name: string; size?: number }) {
  if (hasAppMark(name)) return <AppMark name={name} size={size} />;

  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[5px] font-medium"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.52,
        background: `hsl(${hash} 45% 12%)`,
        color: `hsl(${hash} 55% 72%)`,
        boxShadow: `inset 0 0 0 1px hsl(${hash} 40% 22%)`,
      }}
    >
      {name[0]?.toUpperCase()}
    </span>
  );
}

/** Board: the app's panel card — header rule, uppercase title, quiet
 * right-side note, optional explanatory foot caption. */
export function Board({
  title,
  note,
  foot,
  children,
  className = "",
}: {
  title: ReactNode;
  note?: ReactNode;
  foot?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-[12px] border ${className}`}
      style={{ background: APP.panel, borderColor: APP.hairline }}
    >
      <div
        className="flex items-baseline justify-between border-b px-[15px] pb-[9px] pt-[11px]"
        style={{ borderColor: APP.hairline }}
      >
        <h3
          className="text-[13px] font-semibold uppercase tracking-[0.05em]"
          style={{ color: APP.text }}
        >
          {title}
        </h3>
        {note ? (
          <span className="text-[12px]" style={{ color: APP.dim }}>
            {note}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-[11px] px-[15px] pb-[15px] pt-[13px]">
        {children}
      </div>
      {foot ? (
        <p
          className="border-t px-[15px] pb-[11px] pt-[9px] text-[12px] leading-snug"
          style={{ borderColor: APP.hairline, color: APP.dim }}
        >
          {foot}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * Nav rail
 * ---------------------------------------------------------------- */

function NavGlyph({ kind }: { kind: string }) {
  const s = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" className="shrink-0 opacity-75" aria-hidden>
      {kind === "apps" && (
        <g {...s}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
        </g>
      )}
      {kind === "ai" && (
        <g {...s}>
          <path d="M12 4 L13.8 10.2 L20 12 L13.8 13.8 L12 20 L10.2 13.8 L4 12 L10.2 10.2 Z" />
        </g>
      )}
      {kind === "media" && (
        <g {...s}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M10 8.8 L15.4 12 L10 15.2 Z" />
        </g>
      )}
      {kind === "home" && (
        <g {...s}>
          <path d="M4 11 L12 4.5 L20 11 V19.5 H4 Z" />
          <path d="M10 19.5 V14 H14 V19.5" />
        </g>
      )}
      {kind === "gaming" && (
        <g {...s}>
          <path d="M7 8.5 H17 C19.5 8.5 21 10.5 21 13 C21 15.5 19.3 17 17.5 16 L15.5 14.8 H8.5 L6.5 16 C4.7 17 3 15.5 3 13 C3 10.5 4.5 8.5 7 8.5 Z" />
          <path d="M8 11.5 V14 M6.8 12.8 H9.2" />
        </g>
      )}
      {kind === "network" && (
        <g {...s}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12 H20.5" />
          <ellipse cx="12" cy="12" rx="4" ry="8.5" />
        </g>
      )}
      {kind === "system" && (
        <g {...s}>
          <rect x="3.5" y="5" width="17" height="6" rx="2" />
          <rect x="3.5" y="13" width="17" height="6" rx="2" />
          <circle cx="7.2" cy="8" r="0.4" />
          <circle cx="7.2" cy="16" r="0.4" />
        </g>
      )}
      {kind === "monitoring" && (
        <g {...s}>
          <path d="M2.9 12.7 h4.3 l2.45 -6.4 3.7 11.5 2.35 -5.1 h5.4" />
        </g>
      )}
      {kind === "claude" && (
        <path
          fill="currentColor"
          d="M12 3.5 L13.6 9 L18.8 6.6 L15.2 11.2 L21 12 L15.2 12.8 L18.8 17.4 L13.6 15 L12 20.5 L10.4 15 L5.2 17.4 L8.8 12.8 L3 12 L8.8 11.2 L5.2 6.6 L10.4 9 Z"
        />
      )}
    </svg>
  );
}

const NAV_MAIN = [
  { id: "apps", label: "Apps" },
  { id: "ai", label: "AI" },
  { id: "media", label: "Media" },
  { id: "home", label: "Home" },
  { id: "gaming", label: "Gaming" },
  { id: "network", label: "Network" },
  { id: "system", label: "System" },
  { id: "monitoring", label: "Monitoring" },
];

/** The daedalus icon at rail size. */
function RailMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="7" fill={APP.accent} />
      <path
        d="M16 16 L16 20 L12 20 L12 12 L20 12 L20 24 L8 24 L8 8 L24 8 L24 28 L4 28 L4 4 L28 4"
        stroke="#fdf3ef"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Rail({ active }: { active: string }) {
  const item = (id: string, label: string) => {
    const on = id === active;
    return (
      <span
        key={id}
        className="flex items-center gap-[10px] rounded-[9px] px-[10px] py-[7px] text-[13.5px]"
        style={
          on
            ? { background: `${APP.accent}21`, color: APP.accent, fontWeight: 550 }
            : { color: APP.muted }
        }
      >
        <NavGlyph kind={id} />
        {label}
      </span>
    );
  };
  return (
    <div
      className="flex w-[210px] shrink-0 flex-col border-r px-[12px] pb-[14px] pt-[16px]"
      style={{ background: APP.rail, borderColor: APP.hairline }}
    >
      <div className="mb-[18px] flex items-center gap-[10px] px-[4px]">
        <RailMark />
        <span className="flex flex-col leading-tight">
          <span
            className="text-[11.5px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: APP.text }}
          >
            daedalus
          </span>
          <span
            className="text-[9.5px] uppercase tracking-[0.2em]"
            style={{ color: APP.dim }}
          >
            workshop
          </span>
        </span>
      </div>
      <div className="flex flex-col gap-[2px]">
        {item("apps", "Apps")}
        <span className="mx-[6px] my-[7px] h-px" style={{ background: APP.hairline }} />
        {NAV_MAIN.slice(1).map((n) => item(n.id, n.label))}
      </div>
      <div className="mt-auto flex flex-col gap-[2px]">
        <span className="mx-[6px] my-[7px] h-px" style={{ background: APP.hairline }} />
        {item("claude", "Claude")}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * The window shell
 * ---------------------------------------------------------------- */

/** Traffic-light title bar + the app's sidebar/content shell. Every demo
 * view renders inside this. */
export function Shell({ active, children }: { active: string; children: ReactNode }) {
  return (
    <div className="flex size-full flex-col" style={{ background: APP.bg, color: APP.text }}>
      <div
        className="relative flex h-[44px] shrink-0 items-center border-b px-[18px]"
        style={{ background: APP.rail, borderColor: APP.hairline }}
      >
        <span className="flex gap-[7px]">
          <span className="size-[11px] rounded-full bg-[#ff5f57]" />
          <span className="size-[11px] rounded-full bg-[#febc2e]" />
          <span className="size-[11px] rounded-full bg-[#28c840]" />
        </span>
        <span
          className="absolute inset-x-0 text-center font-mono text-[12px]"
          style={{ color: APP.dim }}
        >
          daedalus-app.toscanini.me
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <Rail active={active} />
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden px-[34px] pt-[26px]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Page h1 + lede, as the app sets them. */
export function PageHead({ title, lede }: { title: string; lede: string }) {
  return (
    <div>
      <h1 className="text-[24px] font-semibold tracking-[-0.02em]" style={{ color: APP.text }}>
        {title}
      </h1>
      <p className="mt-[6px] max-w-[72ch] text-[13.5px] leading-relaxed" style={{ color: APP.muted }}>
        {lede}
      </p>
    </div>
  );
}

/** The app's tab row — active tab gets a 2px accent underline; category
 * pages bake a status dot into each tab. */
export function Tabs({
  items,
  active,
}: {
  items: Array<{ label: string; dot?: Tone }>;
  active: string;
}) {
  return (
    <div
      className="mt-[16px] flex items-center gap-[22px] border-b"
      style={{ borderColor: APP.hairline }}
    >
      {items.map((t) => {
        const on = t.label === active;
        return (
          <span
            key={t.label}
            className="flex items-center gap-[7px] pb-[9px] text-[13.5px] capitalize"
            style={{
              color: on ? APP.text : APP.muted,
              boxShadow: on ? `inset 0 -2px 0 ${APP.accent}` : undefined,
            }}
          >
            {t.dot ? (
              <span
                className="size-[7px] rounded-full"
                style={{ background: TONE[t.dot] }}
              />
            ) : null}
            {t.label}
          </span>
        );
      })}
    </div>
  );
}
