import { APP, AppTile, Btn, PageHead, Shell, Spark, Table, Tabs, Tr, alpha } from "../chrome";

/** The flagship screen: Apps as the app now draws it, one table of every
 * app on the box with its address, exposure (Off, Lab, Public), traffic and
 * last deploy, the control plane in its own row group, and the Apply bar
 * floating over the foot with one change queued. Mirrors
 * app/src/routes/apps.index.tsx. */

const COLS = "minmax(0,2.1fr) minmax(0,1.45fr) 78px 104px 74px 70px";

interface AppRow {
  name: string;
  desc: string;
  sub: string;
  stage: "Public" | "Lab";
  rpm: string;
  spark: number[];
  deployed: string;
}

const ROWS: AppRow[] = [
  {
    name: "anansi",
    desc: "Task-tracking experiment",
    sub: "anansi",
    stage: "Public",
    rpm: "23.4",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 1, 6],
    deployed: "8h ago",
  },
  {
    name: "argus",
    desc: "Internet exposure catalogue",
    sub: "argus",
    stage: "Lab",
    rpm: "1.1",
    spark: [0, 5, 6, 0, 0, 0, 0, 0, 0, 0],
    deployed: "2d ago",
  },
  {
    name: "chismed",
    desc: "WhatsApp chat analyzer",
    sub: "chismed",
    stage: "Public",
    rpm: "6.5",
    spark: [0, 1, 0, 0, 0, 0, 0, 0, 0, 5],
    deployed: "2d ago",
  },
  {
    name: "hermes",
    desc: "Smart reader: RSS with AI TL;DRs and a Hacker News lens",
    sub: "hermes",
    stage: "Public",
    rpm: "12.0",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
    deployed: "8h ago",
  },
  {
    name: "iris",
    desc: "One QR code, forever: retargetable QR codes and a linktree",
    sub: "iris",
    stage: "Public",
    rpm: "17.5",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
    deployed: "7h ago",
  },
  {
    name: "lintel",
    desc: "Scan a room with an iPhone and walk through it in the browser",
    sub: "lintel",
    stage: "Public",
    rpm: "23.8",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 6],
    deployed: "8h ago",
  },
  {
    name: "voyra",
    desc: "Trips, shared and remembered",
    sub: "voyra",
    stage: "Public",
    rpm: "12.8",
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 1, 6],
    deployed: "8h ago",
  },
];

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

function Row({ row, first }: { row: AppRow; first?: boolean }) {
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
      <code className="truncate font-mono text-[11.5px]" style={{ color: APP.text }}>
        {row.sub}
        <span style={{ color: APP.muted }}>.toscanini.me</span>
      </code>
      <span className="flex items-center gap-[6px] text-[12.5px]" style={{ color: APP.subdued }}>
        {row.stage === "Lab" ? <Flask /> : null}
        {row.stage}
      </span>
      <span className="flex items-center gap-[8px] text-[12.5px]" style={{ color: APP.text }}>
        <span className="w-[30px] text-right">{row.rpm}</span>
        <Spark pts={row.spark} />
      </span>
      <span className="text-[12.5px]" style={{ color: APP.subdued }}>
        {row.deployed}
      </span>
      <span className="text-[12.5px]" style={{ color: APP.subdued }}>
        Running
      </span>
    </Tr>
  );
}

export function AppsView() {
  return (
    <Shell active="apps">
      <PageHead title="Apps" action={<Btn>Add an app</Btn>} />
      <Tabs items={["Overview", "Container registry", "npm packages", "Builder"]} active="Overview" />

      {/* Filters */}
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
          All <span style={{ color: APP.subdued, fontWeight: 400 }}>&ensp;8</span>
        </span>
        <span
          className="rounded-[8px] border px-[11px] py-[6px]"
          style={{ borderColor: APP.hairline, color: APP.subdued }}
        >
          Any exposure&ensp;⌄
        </span>
      </div>

      <div className="mt-[14px]">
        <Table cols={COLS} head={["App", "Address", "Exposure", "Req/min", "Deployed", "Status"]}>
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
              spark: [0, 0, 0, 0, 0, 0, 0, 0, 2, 6],
              deployed: "",
            }}
          />
        </Table>
      </div>

      {/* The Apply bar: a glass dock over the page's foot, its edge in the
          brand because something is waiting (app/src/components/apply-bar.tsx). */}
      <div
        className="absolute inset-x-[22px] bottom-[16px] flex items-center gap-[12px] rounded-[16px] border px-[18px] py-[11px] text-[13px]"
        style={{
          background: alpha("oklch(0.245 0.004 270)", 88),
          borderColor: alpha(APP.accent, 35),
          boxShadow: `0 18px 50px -12px rgba(0,0,0,0.7), 0 0 40px -14px ${APP.accent}`,
          backdropFilter: "blur(20px)",
        }}
      >
        <b style={{ color: APP.text, fontWeight: 600 }}>1 app changed</b>
        <span style={{ color: APP.muted }}>lintel (stage)</span>
        <span className="ml-auto flex gap-[8px]">
          <Btn ghost>Discard</Btn>
          <Btn>Apply</Btn>
        </span>
      </div>
    </Shell>
  );
}
