import { APP, AppTile, Chip, Dot, PageHead, Shell, Spark, Tabs, type Tone } from "../chrome";

/** The flagship screen: the fleet as a list — status, hostname, exposure,
 * traffic — with the Apply bar pinned to the bottom edge. */

interface AppRow {
  name: string;
  desc: string;
  host: string;
  tone: Tone;
  exposure: "external" | "internal";
  spark: number[];
  rpm: string;
  chips?: Array<{ tone: Tone; label: string }>;
}

const ROWS: AppRow[] = [
  {
    name: "anansi",
    desc: "Task-tracking experiment",
    host: "anansi.toscanini.me",
    tone: "ok",
    exposure: "external",
    spark: [2, 3, 2, 5, 4, 6, 3, 4, 5, 4],
    rpm: "2.4 rpm",
  },
  {
    name: "argus",
    desc: "Exposed-webcam catalogue",
    host: "argus.toscanini.me",
    tone: "bad",
    exposure: "internal",
    spark: [3, 3, 4, 2, 6, 1, 1, 1, 1, 1],
    rpm: "0.3 rpm",
  },
  {
    name: "chismed",
    desc: "WhatsApp chat analyzer",
    host: "chismed.toscanini.me",
    tone: "ok",
    exposure: "external",
    spark: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    rpm: "0.1 rpm",
  },
  {
    name: "hermes",
    desc: "Smart reader — RSS with AI TL;DRs and a Hacker News lens",
    host: "hermes.toscanini.me",
    tone: "ok",
    exposure: "external",
    spark: [1, 4, 2, 5, 3, 6, 2, 5, 3, 4],
    rpm: "1.8 rpm",
    chips: [{ tone: "warn", label: "unapplied" }],
  },
  {
    name: "iris",
    desc: "One QR code, forever — retargetable QRs and a linktree",
    host: "iris.toscanini.me",
    tone: "ok",
    exposure: "external",
    spark: [2, 2, 3, 5, 6, 5, 4, 3, 3, 2],
    rpm: "0.9 rpm",
  },
  {
    name: "voyra",
    desc: "Trips, shared and remembered",
    host: "voyra.toscanini.me",
    tone: "ok",
    exposure: "external",
    spark: [3, 2, 3, 2, 4, 3, 2, 3, 4, 3],
    rpm: "0.5 rpm",
  },
];

function Row({ row }: { row: AppRow }) {
  return (
    <div
      className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] items-center gap-[16px] border-t px-[16px] py-[11px]"
      style={{ borderColor: APP.hairline }}
    >
      <Dot tone={row.tone} pulse={row.tone === "bad"} />
      <AppTile name={row.name} />
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-[8px]">
          <span className="text-[14.5px] font-semibold" style={{ color: APP.text }}>
            {row.name}
          </span>
          {row.chips?.map((c) => (
            <Chip key={c.label} tone={c.tone}>
              {c.label}
            </Chip>
          ))}
        </span>
        <span className="truncate text-[12px]" style={{ color: APP.dim }}>
          {row.desc}
        </span>
      </span>
      <code className="font-mono text-[12.5px]" style={{ color: APP.muted }}>
        {row.host}
      </code>
      <Chip tone={row.exposure === "external" ? "ok" : "info"}>{row.exposure}</Chip>
      <span className="flex items-center gap-[10px]">
        <Spark pts={row.spark} tone={row.tone === "bad" ? "bad" : "muted"} />
        <span className="w-[52px] text-right text-[11.5px]" style={{ color: APP.dim }}>
          {row.rpm}
        </span>
      </span>
    </div>
  );
}

export function AppsView() {
  return (
    <Shell active="apps">
      <PageHead
        title="Apps"
        lede="What this box runs of its own, what lives on someone else's infrastructure, and the two registries everything here is built out of."
      />
      <Tabs
        items={[{ label: "Apps" }, { label: "Container registry" }, { label: "npm packages" }]}
        active="Apps"
      />

      {/* Tallies + primary action */}
      <div className="mt-[14px] flex items-center gap-[24px] text-[13px]" style={{ color: APP.muted }}>
        <span className="flex items-center gap-[8px]">
          <Dot tone="ok" />
          <b style={{ color: APP.text, fontWeight: 600 }}>5</b> running
        </span>
        <span className="flex items-center gap-[8px]">
          <Dot tone="bad" />
          <b style={{ color: APP.text, fontWeight: 600 }}>1</b> needs attention
        </span>
        <span className="flex items-center gap-[8px]">
          <Dot tone="muted" />
          <b style={{ color: APP.text, fontWeight: 600 }}>0</b> stopped
        </span>
        <span
          className="ml-auto rounded-[8px] px-[13px] py-[6px] text-[12.5px] font-semibold"
          style={{ background: APP.accent, color: "#1a0d08" }}
        >
          Add an app
        </span>
      </div>

      {/* Section head */}
      <div className="mt-[16px] flex items-baseline gap-[10px]">
        <h2 className="text-[14px] font-semibold" style={{ color: APP.text }}>
          Daedalus
        </h2>
        <span className="text-[12px]" style={{ color: APP.dim }}>
          deployed, watched and managed on this box
        </span>
      </div>

      {/* The list — one bordered container, hairline-divided rows */}
      <div
        className="mt-[9px] overflow-hidden rounded-[12px] border [&>div:first-child]:border-t-0"
        style={{ background: APP.panel, borderColor: APP.hairline }}
      >
        {ROWS.map((r) => (
          <Row key={r.name} row={r} />
        ))}
      </div>

      {/* Control plane */}
      <div className="mt-[14px] flex items-baseline gap-[10px]">
        <h2 className="text-[14px] font-semibold" style={{ color: APP.text }}>
          Control plane
        </h2>
        <span className="text-[12px]" style={{ color: APP.dim }}>
          declared in Nix, not editable here
        </span>
      </div>
      <div
        className="mt-[9px] overflow-hidden rounded-[12px] border [&>div:first-child]:border-t-0"
        style={{ background: APP.panel, borderColor: APP.hairline }}
      >
        <Row
          row={{
            name: "daedalus",
            desc: "S2 control plane",
            host: "daedalus-app.toscanini.me",
            tone: "ok",
            exposure: "internal",
            spark: [2, 2, 3, 2, 2, 3, 2, 2, 2, 3],
            rpm: "0.8 rpm",
            chips: [{ tone: "muted", label: "nix" }],
          }}
        />
      </div>

      {/* The Apply bar — pinned to the window's bottom edge */}
      <div
        className="absolute inset-x-0 bottom-0 flex items-center gap-[14px] border-t px-[34px] py-[13px] text-[13px]"
        style={{
          background: "rgba(17,17,19,0.94)",
          borderColor: APP.accentDim,
          color: APP.muted,
        }}
      >
        <b style={{ color: APP.text, fontWeight: 600 }}>1 app changed</b>
        <span>hermes (litellm key · stage)</span>
        <span
          className="ml-auto rounded-[8px] px-[16px] py-[6px] text-[12.5px] font-semibold"
          style={{ background: APP.accent, color: "#1a0d08" }}
        >
          Apply
        </span>
      </div>
    </Shell>
  );
}
