/** Shared chrome + leaf primitives for the demo windows: the app's real
 * shell (the rail, the inset content panel, tables, chips) hand-rebuilt at
 * desktop density on the fixed 1280×800 canvas. Colors are the app's own
 * dark-theme tokens (app/src/theme.css, `[data-theme="dark"]`), copied as
 * OKLCH, so the demo looks like daedalus and not like this site.
 *
 * Resync by hand when the app's shell changes: the reference is the app's
 * own pages in its dark theme (shot daedalus, with data-theme="dark").
 * Last resynced 2026-10-07, after the UI redesign (Apps as a table, the
 * grey ladder, the ⌘K search in the rail).
 *
 * NOTHING IN HERE IS A HEADING. These are pictures of another product's UI,
 * wrapped in `role="img"` with a written description (demo-window.tsx), so
 * every word inside is paint. Written as `h1`/`h2`/`h3` they were real
 * headings in THIS document and the page outline filled up with "Apps".
 * A styled paragraph looks identical and claims nothing. Keep it that way. */

import type { ReactNode } from "react";

import { AppMark, hasAppMark } from "./app-marks";

export const APP = {
  rail: "oklch(0.172 0.004 270)",
  bg: "oklch(0.2 0.004 270)",
  card: "oklch(0.23 0.004 270)",
  surface: "color-mix(in oklch, oklch(0.94 0.002 270) 2.6%, oklch(0.2 0.004 270))",
  panel2: "oklch(0.25 0.004 270)",
  raise: "oklch(0.285 0.004 270)",
  border: "oklch(0.3 0.004 270)",
  hairline: "color-mix(in oklch, oklch(0.94 0.002 270) 8%, transparent)",
  text: "oklch(0.94 0.002 270)",
  subdued: "oklch(0.76 0.004 270)",
  muted: "oklch(0.68 0.006 270)",
  accent: "oklch(0.6881 0.1381 37.27)",
  ok: "oklch(0.6637 0.1114 158.88)",
  warn: "oklch(0.7507 0.1295 79.85)",
  bad: "oklch(0.6294 0.1776 23.72)",
  info: "oklch(0.642 0.1269 258.52)",
} as const;

/** A token at a given opacity, the way the app's own mixes are written. */
export const alpha = (c: string, pct: number) => `color-mix(in oklch, ${c} ${pct}%, transparent)`;

export type Tone = "ok" | "warn" | "bad" | "info" | "muted" | "accent";

export const TONE: Record<Tone, string> = {
  ok: APP.ok,
  warn: APP.warn,
  bad: APP.bad,
  info: APP.info,
  muted: APP.muted,
  accent: APP.accent,
};

/* ---------------------------------------------------------------- *
 * Leaf pieces
 * ---------------------------------------------------------------- */

/** The app's quiet pill: a hairline ring and the tone's ink. */
export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-[8px] py-[1px] text-[11px] leading-[1.5]"
      style={{
        borderColor: alpha(c, 40),
        background: alpha(c, 10),
        color: tone === "muted" ? APP.subdued : c,
      }}
    >
      {children}
    </span>
  );
}

/** The table's req/min trace: a flat baseline with the last minutes'
 * movement, stroke only, as the app draws it. */
export function Spark({ pts, w = 52, h = 16 }: { pts: number[]; w?: number; h?: number }) {
  const max = Math.max(...pts) || 1;
  const d = pts
    .map(
      (p, i) =>
        `${((i / (pts.length - 1)) * w).toFixed(1)},${(h - 1.5 - (p / max) * (h - 3)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <polyline
        points={d}
        fill="none"
        stroke={APP.subdued}
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** An app's icon: its own mark when it ships one, the monogram otherwise,
 * in the same order daedalus resolves them. */
export function AppTile({ name, size = 28 }: { name: string; size?: number }) {
  if (hasAppMark(name)) return <AppMark name={name} size={size} />;

  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-[7px] font-medium"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: `hsl(${hash} 40% 16%)`,
        color: `hsl(${hash} 55% 72%)`,
      }}
    >
      {name[0]?.toUpperCase()}
    </span>
  );
}

/** A bordered table, as the app draws one: a header row in small subdued
 * type, hairline-divided body rows. `cols` is the CSS grid template every
 * row shares. */
export function Table({
  cols,
  head,
  children,
}: {
  cols: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <div
      className="overflow-hidden rounded-[12px] border"
      style={{ background: APP.surface, borderColor: APP.hairline }}
    >
      <div
        className="grid items-center gap-[14px] border-b px-[18px] py-[9px] text-[11.5px] font-medium"
        style={{ gridTemplateColumns: cols, borderColor: APP.hairline, color: APP.subdued }}
      >
        {head.map((h, i) => (
          <span key={h || i}>{h}</span>
        ))}
      </div>
      {children}
    </div>
  );
}

export function Tr({
  cols,
  children,
  first = false,
}: {
  cols: string;
  children: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={`grid items-center gap-[14px] px-[18px] py-[10px] ${first ? "" : "border-t"}`}
      style={{ gridTemplateColumns: cols, borderColor: APP.hairline }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * The rail
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
    <svg width={15} height={15} viewBox="0 0 24 24" className="shrink-0 opacity-80" aria-hidden>
      {kind === "apps" && (
        <g {...s}>
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
          <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
          <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
        </g>
      )}
      {kind === "back" && <path {...s} d="M14.5 6 L8.5 12 L14.5 18" />}
      {kind === "ai" && (
        <g {...s}>
          <path d="M11 4 L12.6 9.4 L18 11 L12.6 12.6 L11 18 L9.4 12.6 L4 11 L9.4 9.4 Z" />
          <path d="M18.5 15.5 v4 M16.5 17.5 h4" />
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
      {kind === "health" && (
        <g {...s}>
          <path d="M12 19.5 C6 15.5 3.5 12.5 3.5 9 A4.2 4.2 0 0 1 12 7 A4.2 4.2 0 0 1 20.5 9 C20.5 12.5 18 15.5 12 19.5 Z" />
          <path d="M6.5 12 H10 L11.2 10 L13 14 L14.2 12 H17.5" />
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
      {kind === "database" && (
        <g {...s}>
          <ellipse cx="12" cy="6" rx="7" ry="2.5" />
          <path d="M5 6 V18 C5 19.4 8.1 20.5 12 20.5 C15.9 20.5 19 19.4 19 18 V6" />
          <path d="M5 12 C5 13.4 8.1 14.5 12 14.5 C15.9 14.5 19 13.4 19 12" />
        </g>
      )}
      {kind === "actions" && (
        <g {...s}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M10.2 9 L15 12 L10.2 15 Z" />
        </g>
      )}
      {kind === "monitoring" && (
        <path {...s} d="M2.9 12.7 h4.3 l2.45 -6.4 3.7 11.5 2.35 -5.1 h5.4" />
      )}
      {kind === "system" && (
        <g {...s}>
          <rect x="4" y="5" width="16" height="6" rx="1.8" />
          <rect x="4" y="13" width="16" height="6" rx="1.8" />
          <path d="M7.5 8 h.01 M7.5 16 h.01" />
        </g>
      )}
      {kind === "account" && (
        <g {...s}>
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20 C5.8 16 8.6 14 12 14 C15.4 14 18.2 16 19 20" />
        </g>
      )}
      {kind === "overview" && (
        <g {...s}>
          <rect x="4" y="4.5" width="16" height="15" rx="2" />
          <path d="M4 9.5 H20 M10 9.5 V19.5" />
        </g>
      )}
      {kind === "deployments" && (
        <g {...s}>
          <path d="M12 4 L20 8 L12 12 L4 8 Z" />
          <path d="M4 12 L12 16 L20 12 M4 16 L12 20 L20 16" />
        </g>
      )}
      {kind === "settings" && <path {...s} d="M4 7 H20 M4 12 H20 M4 17 H20" />}
    </svg>
  );
}

/** The daedalus icon at rail size. */
function RailMark({ size = 22 }: { size?: number }) {
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

const SERVICES = [
  { id: "ai", label: "AI" },
  { id: "media", label: "Media" },
  { id: "home", label: "Home" },
  { id: "health", label: "Health" },
  { id: "gaming", label: "Gaming" },
];
const INFRA = [
  { id: "network", label: "Network", dot: true },
  { id: "database", label: "Database" },
  { id: "actions", label: "Actions" },
  { id: "monitoring", label: "Monitoring", dot: true },
];

function RailItem({
  id,
  label,
  on,
  dot,
}: {
  id: string;
  label: string;
  on: boolean;
  dot?: boolean;
}) {
  return (
    <span
      className="flex items-center gap-[10px] rounded-[8px] px-[9px] py-[6px] text-[13px]"
      style={on ? { background: APP.panel2, color: APP.text } : { color: APP.subdued }}
    >
      <NavGlyph kind={id} />
      <span className="flex-1">{label}</span>
      {dot ? <span className="size-[6px] rounded-full" style={{ background: APP.ok }} /> : null}
    </span>
  );
}

function RailLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-[3px] mt-[14px] px-[9px] text-[11px]" style={{ color: APP.muted }}>
      {children}
    </p>
  );
}

/** The rail: the main sections, or, inside an app, that app's own pages. */
function Rail({ active, app }: { active: string; app?: string }) {
  return (
    <div className="flex w-[214px] shrink-0 flex-col px-[10px] pb-[12px] pt-[14px]">
      <div className="mb-[12px] flex items-center gap-[9px] px-[6px]">
        <RailMark />
        <span className="flex-1 text-[14px] font-semibold" style={{ color: APP.text }}>
          Daedalus
        </span>
        <span className="text-[13px]" style={{ color: APP.muted }}>
          ‹
        </span>
      </div>
      <div
        className="mb-[10px] flex items-center gap-[8px] rounded-[8px] border px-[9px] py-[6px] text-[12.5px]"
        style={{ background: APP.bg, borderColor: APP.hairline, color: APP.muted }}
      >
        <svg width={13} height={13} viewBox="0 0 24 24" aria-hidden>
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16 L20 20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span className="flex-1">Search</span>
        <span
          className="rounded-[4px] border px-[5px] text-[10.5px]"
          style={{ borderColor: APP.hairline }}
        >
          ⌘K
        </span>
      </div>

      {app ? (
        <div className="flex flex-col gap-[1px]">
          <RailItem id="back" label="All apps" on={false} />
          <span className="mx-[8px] my-[8px] h-px" style={{ background: APP.hairline }} />
          <p className="mb-[3px] px-[9px] text-[12px] font-semibold" style={{ color: APP.text }}>
            {app}
          </p>
          {["overview", "deployments", "database", "settings"].map((id) => (
            <RailItem
              key={id}
              id={id}
              label={id.charAt(0).toUpperCase() + id.slice(1)}
              on={id === active}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-[1px]">
          <RailItem id="apps" label="Apps" on={active === "apps"} />
          <RailLabel>Services</RailLabel>
          {SERVICES.map((n) => (
            <RailItem key={n.id} id={n.id} label={n.label} on={n.id === active} dot />
          ))}
          <RailLabel>Infrastructure</RailLabel>
          {INFRA.map((n) => (
            <RailItem key={n.id} id={n.id} label={n.label} on={n.id === active} dot={n.dot} />
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-[1px]">
        <span className="mx-[8px] my-[8px] h-px" style={{ background: APP.hairline }} />
        <RailItem id="system" label="System" on={active === "system"} />
        <RailItem id="account" label="Account" on={false} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * The window shell
 * ---------------------------------------------------------------- */

/** Title bar + the rail + the content panel inset into the canvas, which is
 * how the app's grey ladder separates them. Every demo view renders inside. */
export function Shell({
  active,
  app,
  children,
}: {
  active: string;
  app?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex size-full flex-col" style={{ background: APP.rail, color: APP.text }}>
      <div className="relative flex h-[34px] shrink-0 items-center px-[16px]">
        <span className="flex gap-[7px]">
          <span className="size-[10px] rounded-full" style={{ background: APP.raise }} />
          <span className="size-[10px] rounded-full" style={{ background: APP.raise }} />
          <span className="size-[10px] rounded-full" style={{ background: APP.raise }} />
        </span>
        <span
          className="absolute inset-x-0 text-center font-mono text-[11px]"
          style={{ color: APP.muted }}
        >
          daedalus-app.toscanini.me
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <Rail active={active} app={app} />
        <div
          className="relative mb-[8px] mr-[8px] flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border px-[36px] pt-[28px]"
          style={{ background: APP.bg, borderColor: APP.hairline }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** The page title as the app sets it, with the info glyph beside it, and an
 * optional action on the right. */
export function PageHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-[10px]">
      <p className="text-[25px] font-semibold tracking-[-0.02em]" style={{ color: APP.text }}>
        {title}
      </p>
      <span
        className="flex size-[15px] items-center justify-center rounded-full border text-[9px]"
        style={{ borderColor: APP.muted, color: APP.muted }}
      >
        i
      </span>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

/** The app's default button in the dark theme: light fill, dark ink. */
export function Btn({ children, ghost = false }: { children: ReactNode; ghost?: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-[8px] border px-[13px] py-[6px] text-[12.5px] font-semibold"
      style={
        ghost
          ? { borderColor: APP.hairline, background: APP.card, color: APP.text }
          : { borderColor: "transparent", background: APP.text, color: APP.rail }
      }
    >
      {children}
    </span>
  );
}

/** The tab row: the active tab underlined in the foreground ink. */
export function Tabs({ items, active }: { items: string[]; active: string }) {
  return (
    <div
      className="mt-[18px] flex items-center gap-[24px] border-b"
      style={{ borderColor: APP.hairline }}
    >
      {items.map((t) => {
        const on = t === active;
        return (
          <span
            key={t}
            className="pb-[10px] text-[13px]"
            style={{
              color: on ? APP.text : APP.subdued,
              fontWeight: on ? 600 : 400,
              boxShadow: on ? `inset 0 -2px 0 ${APP.text}` : undefined,
            }}
          >
            {t}
          </span>
        );
      })}
    </div>
  );
}

/** A section title above a table, with its quiet note. */
export function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-[10px] flex items-baseline gap-[10px]">
      <p className="text-[14px] font-semibold" style={{ color: APP.text }}>
        {title}
      </p>
      {note ? (
        <span className="text-[12px]" style={{ color: APP.muted }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}
