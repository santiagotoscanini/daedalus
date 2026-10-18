import type { CSSProperties, ReactNode } from "react";

import { ChevronDown } from "~/components/icons";

import { APP, AppTile, Btn, PageHead, Shell, Spark, Table, Tabs, Tr, varies } from "../chrome";

/** The flagship screen: Apps as the app draws it, one table of every app on the box with its
 * address, exposure (Off, Lab, Public), traffic and last deploy, and the control plane in its own
 * row group. Mirrors app/src/routes/apps.index.tsx. `AppsCompact` is the same list at phone
 * density, for the hero below 1024px.
 *
 * The hero's story plays on these rows: the store's page arrives at the top of the table at ARRIVE,
 * washed and building, and runs at RUNS. It is CSS (the .seq* classes in styles.css), paused until
 * the hero sets data-play on .hero-shot; reduced motion and no-script land on the last frame. */

const COLS = "minmax(0,2.1fr) minmax(0,1.45fr) 78px 104px 74px 70px";

interface AppRow {
  name: string;
  desc: string;
  sub: string;
  stage: "Public" | "Lab";
  rpm: string;
  /** req/min across the last two hours, oldest first, ending near `rpm` */
  spark: number[];
  deployed: string;
}

const ROWS: AppRow[] = [
  {
    name: "anansi",
    desc: "A quiet place to understand yourself",
    sub: "anansi",
    stage: "Public",
    rpm: "23.4",
    spark: [18, 21, 19, 23, 20, 24, 22, 21, 25, 23.4],
    deployed: "8h ago",
  },
  {
    name: "argus",
    desc: "Internet exposure catalogue",
    sub: "argus",
    stage: "Lab",
    rpm: "1.1",
    spark: [0.6, 0.6, 1.4, 0.8, 0.6, 0.9, 0.6, 1.2, 0.7, 1.1],
    deployed: "2d ago",
  },
  {
    name: "chismed",
    desc: "WhatsApp chat analyzer",
    sub: "chismed",
    stage: "Public",
    rpm: "6.5",
    spark: [3.1, 3.4, 4.2, 3.8, 4.9, 5.6, 5.1, 6.2, 5.8, 6.5],
    deployed: "2d ago",
  },
  {
    name: "hermes",
    desc: "Smart reader: RSS with AI TL;DRs and a Hacker News lens",
    sub: "hermes",
    stage: "Public",
    rpm: "12.0",
    spark: [14.2, 13.1, 13.8, 12.4, 12.9, 11.6, 12.2, 11.8, 12.6, 12],
    deployed: "8h ago",
  },
  {
    name: "iris",
    desc: "One QR code, forever: retargetable QR codes and a linktree",
    sub: "iris",
    stage: "Public",
    rpm: "17.5",
    spark: [14, 16, 15, 18, 17, 16, 19, 17, 18, 17.5],
    deployed: "7h ago",
  },
  {
    name: "lintel",
    desc: "Scan a room with an iPhone and walk through it in the browser",
    sub: "lintel",
    stage: "Public",
    rpm: "23.8",
    spark: [21.5, 22.4, 21.9, 23.1, 22.6, 24.2, 23.4, 22.8, 24, 23.8],
    deployed: "8h ago",
  },
  {
    name: "sankofa",
    desc: "Transcribe, correct and organize handwritten archival documents",
    sub: "sankofa",
    stage: "Public",
    rpm: "9.1",
    spark: [8.6, 8.9, 8.7, 12.8, 9.4, 8.8, 9, 8.7, 9.3, 9.1],
    deployed: "8h ago",
  },
  {
    name: "voyra",
    desc: "Trips, shared and remembered",
    sub: "voyra",
    stage: "Public",
    rpm: "12.8",
    spark: [11.2, 11.9, 12.6, 12.1, 13.4, 12.9, 12.2, 13.1, 12.5, 12.8],
    deployed: "8h ago",
  },
];

/** The store's page, just asked for, with no icon of its own yet: the monogram, everywhere. No
 * traffic yet either, so its rate is a dash with no trace beside it. */
const FRESH: AppRow = {
  name: "almacen",
  desc: "The store's hours, for mom",
  sub: "almacen",
  stage: "Public",
  rpm: "–",
  spark: [],
  deployed: "just now",
};

/** The hero's clock, in seconds after play: the new row arrives building, then runs. The
 * conversation (components/messages.tsx) is timed against the same two moments. */
export const ARRIVE = 1.6;
export const RUNS = 3.6;

/** A piece of the sequence starts `s` seconds after play. */
export const at = (s: number) => ({ "--at": `${s}s` }) as CSSProperties;

function Flask() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <path
        d="M9 3.5 H15 M10 3.5 V9.5 L4.8 18.6 A1.3 1.3 0 0 0 6 20.5 H18 A1.3 1.3 0 0 0 19.2 18.6 L14 9.5 V3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The new row's slot. It opens at ARRIVE and stays washed until RUNS, when the wash fades. Its
 * divider is its own bottom edge, inside the clip, so the table shows one line under its header
 * before the row arrives, never two. */
function Fresh({ children }: { children: ReactNode }) {
  return (
    <div className="seq-row" style={at(ARRIVE)}>
      <div className="seq-wash border-b" style={{ ...at(RUNS), borderColor: APP.hairline }}>
        {children}
      </div>
    </div>
  );
}

/** Building in the product's own terracotta, its dot pulsing twice, then Running. */
function FreshStatus() {
  return (
    <span className="seq-swap text-[12.5px] font-medium">
      <span className="seq-out flex items-center gap-[7px]" style={{ ...at(RUNS), color: APP.accent }}>
        <span className="seq-pulse size-[7px] rounded-full" style={{ ...at(ARRIVE), background: APP.accent }} />
        Building
      </span>
      <span className="seq flex items-center gap-[7px]" style={{ ...at(RUNS), color: APP.ok }}>
        <span className="size-[7px] rounded-full" style={{ background: APP.ok }} />
        Running
      </span>
    </span>
  );
}

function Address({ sub }: { sub: string }) {
  return (
    <code className="truncate font-mono text-[11.5px]" style={{ color: APP.text }}>
      {sub}
      <span style={{ color: APP.muted }}>.toscanini.me</span>
    </code>
  );
}

function Row({ row, first = false, fresh = false }: { row: AppRow; first?: boolean; fresh?: boolean }) {
  return (
    <Tr cols={COLS} first={first}>
      <span className="flex min-w-0 items-center gap-[12px]">
        <AppTile name={row.name} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="text-[13.5px] font-semibold" style={{ color: APP.text }}>
            {row.name}
          </span>
          <span className="truncate text-[12px]" style={{ color: APP.subdued }}>
            {row.desc}
          </span>
        </span>
      </span>
      <Address sub={row.sub} />
      <span className="flex items-center gap-[6px] text-[12.5px]" style={{ color: APP.subdued }}>
        {row.stage === "Lab" ? <Flask /> : null}
        {row.stage}
      </span>
      <span className="flex items-center gap-[8px] text-[12.5px]" style={{ color: APP.text }}>
        <span className="w-[30px] text-right">{row.rpm}</span>
        {varies(row.spark) ? <Spark pts={row.spark} /> : null}
      </span>
      <span className="text-[12.5px]" style={{ color: APP.subdued }}>
        {row.deployed}
      </span>
      {fresh ? (
        <FreshStatus />
      ) : (
        <span className="text-[12.5px]" style={{ color: APP.subdued }}>
          Running
        </span>
      )}
    </Tr>
  );
}

/** Apps as the store's page arrives at the top of the table, above the apps the box already runs. */
export function AppsView() {
  return (
    <Shell active="apps">
      <PageHead title="Apps" action={<Btn>Add an app</Btn>} />
      <Tabs items={["Overview", "Container registry", "npm packages", "Builder"]} active="Overview" />

      <div className="mt-[16px] flex items-center gap-[8px] text-[12.5px]">
        <span
          className="flex w-[250px] items-center gap-[8px] rounded-[8px] border px-[11px] py-[6px]"
          style={{ borderColor: APP.hairline, background: APP.surface, color: APP.muted }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden>
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16 L20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Search apps
        </span>
        <span
          className="rounded-[8px] border px-[10px] py-[6px] font-semibold"
          style={{ borderColor: APP.border, background: APP.panel2, color: APP.text }}
        >
          All{" "}
          <span style={{ color: APP.subdued, fontWeight: 400 }}>
            &ensp;
            <span className="seq-swap">
              <span className="seq-out" style={at(ARRIVE)}>
                {ROWS.length}
              </span>
              <span className="seq" style={at(ARRIVE)}>
                {ROWS.length + 1}
              </span>
            </span>
          </span>
        </span>
        <span
          className="flex items-center gap-[6px] rounded-[8px] border px-[11px] py-[6px]"
          style={{ borderColor: APP.hairline, color: APP.subdued }}
        >
          Any exposure
          <ChevronDown size={10} />
        </span>
      </div>

      <div className="mt-[14px]">
        <Table cols={COLS} head={["App", "Address", "Exposure", "Req/min", "Deployed", "Status"]}>
          <Fresh>
            <Row row={FRESH} first fresh />
          </Fresh>
          {ROWS.map((r, i) => (
            <Row key={r.name} row={r} first={i === 0} />
          ))}
          <div
            className="flex items-baseline gap-[10px] border-t px-[18px] py-[7px] text-[12px]"
            style={{ borderColor: APP.hairline, background: APP.rail }}
          >
            <span className="font-semibold" style={{ color: APP.text }}>
              Control plane
            </span>
            <span style={{ color: APP.subdued }}>Declared in Nix</span>
          </div>
          <Row
            row={{
              name: "daedalus",
              desc: "The control plane",
              sub: "daedalus-app",
              stage: "Lab",
              rpm: "38.1",
              spark: [34, 36.5, 35.2, 39.8, 37.1, 36.4, 38.9, 37.6, 39.2, 38.1],
              deployed: "",
            }}
          />
        </Table>
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------------- *
 * Phone density
 * ---------------------------------------------------------------- */

const COMPACT = new Set(["anansi", "hermes", "iris", "lintel", "sankofa"]);

/** One row on the 56px pitch: the tile, the name over its description, the address from 640px,
 * the status. Fixed address and status widths, so every row's columns line up. */
function CompactRow({ row, edge, fresh = false }: { row: AppRow; edge?: "t" | "b"; fresh?: boolean }) {
  return (
    <div
      className={`grid h-[56px] grid-cols-[minmax(0,1fr)_76px] items-center gap-[12px] sm:grid-cols-[minmax(0,1fr)_148px_76px] ${
        edge === "t" ? "border-t" : edge === "b" ? "border-b" : ""
      }`}
      style={{ borderColor: APP.hairline }}
    >
      <span className="flex min-w-0 items-center gap-[12px]">
        <AppTile name={row.name} size={28} />
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-semibold leading-[20px]" style={{ color: APP.text }}>
            {row.name}
          </span>
          <span className="truncate text-[12px] leading-[16px]" style={{ color: APP.subdued }}>
            {row.desc}
          </span>
        </span>
      </span>
      <span className="hidden min-w-0 sm:flex">
        <Address sub={row.sub} />
      </span>
      {fresh ? (
        <FreshStatus />
      ) : (
        <span className="text-[12.5px]" style={{ color: APP.subdued }}>
          Running
        </span>
      )}
    </div>
  );
}

/** Apps below 1024px, at 1:1: the same arrival on a plain list, with no table header. */
export function AppsCompact() {
  const rows = ROWS.filter((r) => COMPACT.has(r.name));
  return (
    <div className="size-full p-[16px] sm:p-[20px]" style={{ background: APP.bg, color: APP.text }}>
      <div className="flex items-center justify-between gap-[12px]">
        <p className="text-[20px] font-semibold" style={{ color: APP.text }}>
          Apps
        </p>
        <Btn>Add an app</Btn>
      </div>
      <div className="mt-[12px]">
        <div className="seq-row" style={at(ARRIVE)}>
          <div className="seq-wash" style={at(RUNS)}>
            <CompactRow row={FRESH} edge="b" fresh />
          </div>
        </div>
        {rows.map((r, i) => (
          <CompactRow key={r.name} row={r} edge={i === 0 ? undefined : "t"} />
        ))}
      </div>
    </div>
  );
}
