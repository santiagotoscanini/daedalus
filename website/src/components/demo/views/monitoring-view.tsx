import { APP, Board, Dot, PageHead, Shell, Spark, TONE, Tabs, type Tone } from "../chrome";

/** Monitoring: the honest board. The StatBand's headline numbers, a probe
 * list where a dead probe reads as unknown — never as healthy — and the
 * alert feed with nothing to hide. */

function BigStat({
  label,
  value,
  sub,
  tone,
  spark,
}: {
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  spark?: number[];
}) {
  const c = TONE[tone];
  return (
    <div
      className="relative overflow-hidden rounded-[12px] border px-[16px] pb-[13px] pt-[14px]"
      style={{
        background: `linear-gradient(160deg, ${APP.panel2}, ${APP.panel})`,
        borderColor: APP.hairline,
      }}
    >
      {/* the tone hairline across the top edge — the app's signature */}
      <span className="absolute inset-x-0 top-0 h-[2px]" style={{ background: c, opacity: 0.85 }} />
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em]" style={{ color: APP.dim }}>
        {label}
      </p>
      <p
        className="mt-[4px] text-[27px] font-semibold tracking-[-0.02em] tabular-nums"
        style={{ color: APP.text }}
      >
        {value}
      </p>
      {spark ? <Spark pts={spark} tone={tone} w={150} h={20} /> : null}
      <p className="mt-[3px] text-[11.5px]" style={{ color: APP.muted }}>
        {sub}
      </p>
    </div>
  );
}

const PROBES: Array<{ name: string; host: string; ms: string; tone: Tone; unknown?: boolean }> = [
  { name: "jellyfin", host: "jellyfin.toscanini.me", ms: "112 ms", tone: "ok" },
  { name: "immich", host: "photos.toscanini.me", ms: "88 ms", tone: "ok" },
  { name: "grafana", host: "grafana.toscanini.me", ms: "64 ms", tone: "ok" },
  { name: "home-assistant", host: "homeassistant.toscanini.me", ms: "—", tone: "muted", unknown: true },
  { name: "nextcloud", host: "nextcloud.toscanini.me", ms: "203 ms", tone: "ok" },
  { name: "argus", host: "argus.toscanini.me", ms: "502", tone: "bad" },
];

export function MonitoringView() {
  return (
    <Shell active="monitoring">
      <PageHead
        title="Monitoring"
        lede="The watchers, and whether each would still tell you."
      />
      <Tabs
        items={[
          { label: "Alerts", dot: "ok" },
          { label: "Probes", dot: "bad" },
          { label: "Metrics", dot: "ok" },
          { label: "Logs", dot: "ok" },
          { label: "Jobs", dot: "ok" },
        ]}
        active="Probes"
      />

      <div className="mt-[16px] grid grid-cols-4 gap-[11px]">
        <BigStat
          label="Endpoints up"
          value="38"
          sub="of 40 probed"
          tone="accent"
          spark={[36, 38, 38, 37, 38, 38, 36, 38, 38, 38]}
        />
        <BigStat label="Rules firing" value="1" sub="argus — probe failing" tone="bad" />
        <BigStat label="30-day uptime" value="99.94 %" sub="across gatus" tone="ok" />
        <BigStat label="Scrape targets" value="41" sub="all reporting" tone="info" />
      </div>

      <div className="mt-[13px] grid grid-cols-2 gap-[13px]">
        <Board
          title="Probes"
          note="every webApp's health path"
          foot="A dead probe renders as unknown, never as healthy. Grey means the question went unanswered."
        >
          {PROBES.map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-[11px] rounded-[9px] border px-[11px] py-[6px]"
              style={{
                background: APP.panel2,
                borderColor: p.unknown ? APP.border : APP.hairline,
                borderStyle: p.unknown ? "dashed" : "solid",
              }}
            >
              <Dot tone={p.tone} pulse={p.tone === "bad"} />
              <span className="text-[12.5px]" style={{ color: APP.text }}>
                {p.name}
              </span>
              <code className="font-mono text-[11px]" style={{ color: APP.dim }}>
                {p.host}
              </code>
              <span
                className="ml-auto font-mono text-[11px] tabular-nums"
                style={{ color: p.tone === "bad" ? APP.bad : APP.dim }}
              >
                {p.unknown ? "no answer" : p.ms}
              </span>
            </div>
          ))}
        </Board>

        <Board
          title="Alert activity"
          note="last 14 days"
          foot="Alerting covers failed units, dead probes, pool health, cert expiry and container staleness. It pages by mail, from the box."
        >
          <div className="flex h-[128px] items-end gap-[7px] pt-[4px]">
            {[2, 0, 0, 1, 0, 0, 0, 3, 1, 0, 0, 0, 1, 4].map((v, i) => (
              <span
                key={`day-${String(i)}`}
                className="flex-1 rounded-t-[3px]"
                style={{
                  height: `${8 + v * 26}px`,
                  background: v === 0 ? APP.raise : i === 13 ? APP.bad : APP.info,
                  opacity: v === 0 ? 0.8 : 0.9,
                }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[10.5px]" style={{ color: APP.dim }}>
            <span>14d ago</span>
            <span>today</span>
          </div>
          <div
            className="flex items-center gap-[10px] rounded-[9px] border px-[11px] py-[7px]"
            style={{ background: `${APP.bad}0f`, borderColor: `${APP.bad}59` }}
          >
            <Dot tone="bad" pulse />
            <span className="text-[12px]" style={{ color: APP.text }}>
              ProbeFailing · argus
            </span>
            <span className="ml-auto font-mono text-[11px]" style={{ color: APP.dim }}>
              firing · 22m
            </span>
          </div>
        </Board>
      </div>
    </Shell>
  );
}
