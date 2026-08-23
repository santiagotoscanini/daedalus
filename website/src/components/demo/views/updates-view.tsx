import { APP, Board, Chip, PageHead, Shell, Tabs, type Tone } from "../chrome";

/** System › Updates: the fleet's digest-pinned images — what moved, the
 * changelog, and the one-at-a-time update button. The settled rows sit
 * back dimmed so the ones that need reading come forward. */

const BEHIND: Array<{
  name: string;
  from: string;
  to: string;
  chip: { tone: Tone; label: string };
  open?: boolean;
}> = [
  {
    name: "jellyfin",
    from: "10.10.6",
    to: "10.11.1",
    chip: { tone: "warn", label: "newer tag" },
    open: true,
  },
  { name: "traefik", from: "v3.3.2", to: "v3.4.0", chip: { tone: "warn", label: "newer tag" } },
  { name: "pihole", from: "2025.07.1", to: "new digest", chip: { tone: "info", label: "tag moved" } },
];

const CURRENT = ["grafana", "prometheus", "loki", "immich", "jellyseerr", "factorio"] as const;

function UpdRow({
  name,
  from,
  to,
  chip,
  quiet = false,
}: {
  name: string;
  from: string;
  to: string;
  chip: { tone: Tone; label: string };
  quiet?: boolean;
}) {
  return (
    <div
      className="flex items-baseline gap-[14px] rounded-[9px] border px-[13px] py-[8px]"
      style={{ background: APP.panel2, borderColor: APP.hairline, opacity: quiet ? 0.72 : 1 }}
    >
      <span className="text-[11px]" style={{ color: APP.dim }}>
        ▸
      </span>
      <span className="min-w-[130px] text-[13px]" style={{ color: APP.text }}>
        {name}
      </span>
      <code className="font-mono text-[12px]" style={{ color: APP.muted }}>
        {from}
      </code>
      <code className="font-mono text-[12px]" style={{ color: APP.text }}>
        <span style={{ color: APP.dim }}>→ </span>
        {to}
      </code>
      <span className="ml-auto">
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </span>
    </div>
  );
}

export function UpdatesView() {
  return (
    <Shell active="system">
      <PageHead
        title="System"
        lede="The machine itself: what it is running on, what it is storing, and what survives it."
      />
      <Tabs
        items={[
          { label: "Host" },
          { label: "Memory" },
          { label: "Disks" },
          { label: "Pools" },
          { label: "Build" },
          { label: "Database" },
          { label: "Updates" },
          { label: "Backups" },
        ]}
        active="Updates"
      />

      <div className="mt-[16px] flex flex-col gap-[13px]">
        <Board title="3 behind" note="registry checked 2026-08-21">
          {BEHIND.map((r) =>
            r.open ? (
              <div
                key={r.name}
                className="overflow-hidden rounded-[9px] border"
                style={{ background: APP.panel2, borderColor: APP.border }}
              >
                <div className="flex items-baseline gap-[14px] px-[13px] py-[8px]">
                  <span className="rotate-90 text-[11px]" style={{ color: APP.dim }}>
                    ▸
                  </span>
                  <span className="min-w-[130px] text-[13px]" style={{ color: APP.text }}>
                    {r.name}
                  </span>
                  <code className="font-mono text-[12px]" style={{ color: APP.muted }}>
                    {r.from}
                  </code>
                  <code className="font-mono text-[12px]" style={{ color: APP.text }}>
                    <span style={{ color: APP.dim }}>→ </span>
                    {r.to}
                  </code>
                  <span className="ml-auto">
                    <Chip tone={r.chip.tone}>{r.chip.label}</Chip>
                  </span>
                </div>
                <div className="px-[13px] pb-[12px] pl-[38px]">
                  {/* the upgrade chain */}
                  <div className="flex items-center gap-[6px] font-mono text-[11px]">
                    {["10.10.6", "10.10.7", "10.11.0", "10.11.1"].map((v, i, a) => (
                      <span key={v} className="flex items-center gap-[6px]">
                        <span
                          className="rounded-[6px] border px-[7px] py-[2px]"
                          style={{
                            borderColor: i === a.length - 1 ? `${APP.warn}73` : APP.border,
                            color: i === a.length - 1 ? APP.warn : APP.muted,
                          }}
                        >
                          {v}
                        </span>
                        {i < a.length - 1 ? <span style={{ color: APP.dim }}>→</span> : null}
                      </span>
                    ))}
                  </div>
                  <p className="mt-[9px] text-[12px] leading-snug" style={{ color: APP.muted }}>
                    10.11: transcode pipeline rework, HDR tone-mapping fixes, trickplay on by
                    default. Two point releases since; no breaking config changes.
                  </p>
                  <div className="mt-[10px] flex items-center gap-[10px]">
                    <span
                      className="rounded-[8px] px-[12px] py-[5px] text-[12px] font-semibold"
                      style={{ background: APP.accent, color: "#1a0d08" }}
                    >
                      Update to 10.11.1
                    </span>
                    <span className="text-[11.5px]" style={{ color: APP.dim }}>
                      resolve · pre-pull · commit · rebuild · verify · revert if it doesn't come
                      back
                    </span>
                  </div>
                  <code
                    className="mt-[10px] block font-mono text-[10.5px]"
                    style={{ color: APP.dim }}
                  >
                    ghcr.io/jellyfin/jellyfin@sha256:a3f91c8e2b04d17c9e0b52aa8f…
                  </code>
                </div>
              </div>
            ) : (
              <UpdRow key={r.name} {...r} />
            ),
          )}
        </Board>

        <Board title="On the newest tag" note="57 containers">
          {CURRENT.map((n) => (
            <UpdRow
              key={n}
              name={n}
              from="pinned digest"
              to="—"
              chip={{ tone: "ok", label: "current" }}
              quiet
            />
          ))}
        </Board>
      </div>
    </Shell>
  );
}
