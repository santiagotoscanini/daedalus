import { APP, AppTile, Board, Chip, Shell, TONE, Tabs, type Tone } from "../chrome";

/** App detail → deployments: the self-hosted runner mid-build, and the
 * timeline of runs where the digest actually moved. */

const HISTORY: Array<{
  rev: string;
  sub: string;
  chip: { tone: Tone; label: string };
  current?: boolean;
}> = [
  {
    rev: "8f2c1d0",
    sub: "2 hours ago · 1m 42s · a3f91c8e2b04 · HTTP 200",
    chip: { tone: "warn", label: "current" },
    current: true,
  },
  {
    rev: "41ba9c2",
    sub: "yesterday · 1m 05s · 7d2e4b91c033 · HTTP 200",
    chip: { tone: "ok", label: "success" },
  },
  {
    rev: "c09e7f1",
    sub: "3 days ago · 2m 18s · 1f8a0c33e5b7 · HTTP 502",
    chip: { tone: "bad", label: "failed" },
  },
  {
    rev: "b3d80e4",
    sub: "4 days ago · 1m 21s · 9c4f7a20d811 · HTTP 200",
    chip: { tone: "ok", label: "success" },
  },
];

export function DeploysView() {
  return (
    <Shell active="apps">
      {/* Breadcrumb */}
      <p className="text-[12.5px]" style={{ color: APP.dim }}>
        Apps <span className="mx-[5px]">›</span>
        <span style={{ color: APP.muted }}>iris</span>
      </p>

      {/* Hero */}
      <div
        className="mt-[10px] flex items-center gap-[16px] rounded-[14px] border px-[20px] py-[16px]"
        style={{ background: APP.panel, borderColor: APP.hairline }}
      >
        <span
          className="flex size-[50px] items-center justify-center rounded-[12px] border"
          style={{ borderColor: `${APP.ok}4d`, background: `${APP.ok}14` }}
        >
          <AppTile name="iris" size={32} />
        </span>
        <span className="flex flex-col gap-[3px]">
          <span className="flex items-center gap-[10px]">
            <span className="text-[19px] font-semibold" style={{ color: APP.text }}>
              iris
            </span>
            <Chip tone="ok">● running</Chip>
          </span>
          <span className="font-mono text-[12.5px]" style={{ color: APP.muted }}>
            ↗ iris.toscanini.me&ensp;&ensp;⎇ santiagotoscanini/iris
          </span>
        </span>
        <span className="ml-auto flex flex-col items-end gap-[6px]">
          <span
            className="text-[10px] uppercase tracking-[0.14em]"
            style={{ color: APP.dim }}
          >
            exposure
          </span>
          <span
            className="flex overflow-hidden rounded-[8px] border text-[12px]"
            style={{ borderColor: APP.border, color: APP.muted }}
          >
            <span className="px-[11px] py-[4px]">Off</span>
            <span className="px-[11px] py-[4px]">Internal</span>
            <span className="px-[11px] py-[4px]" style={{ background: APP.raise, color: APP.text }}>
              External
            </span>
          </span>
        </span>
      </div>

      <Tabs
        items={[
          { label: "overview" },
          { label: "deployments" },
          { label: "database" },
          { label: "access" },
          { label: "settings" },
          { label: "logs" },
        ]}
        active="deployments"
      />

      <div className="mt-[16px] grid grid-cols-[1fr_1.6fr] gap-[13px]">
        {/* The runner, mid-build */}
        <Board title="Runner" note={<Chip tone="warn">busy</Chip>}>
          <code className="font-mono text-[12.5px]" style={{ color: APP.text }}>
            gha-runner-s2
          </code>
          <div
            className="rounded-[9px] border px-[12px] py-[10px]"
            style={{ background: APP.panel2, borderColor: APP.hairline }}
          >
            <div className="flex items-baseline justify-between text-[12.5px]">
              <span style={{ color: APP.text }}>⚙ build-and-push</span>
              <span className="font-mono" style={{ color: APP.dim }}>
                1m 12s
              </span>
            </div>
            <p className="mt-[3px] text-[11.5px]" style={{ color: APP.dim }}>
              step 4/7 · Build image
            </p>
            <div
              className="mt-[8px] h-[5px] overflow-hidden rounded-full"
              style={{ background: APP.raise }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: "58%", background: APP.accent }}
              />
            </div>
          </div>
          <p className="text-[11.5px] leading-snug" style={{ color: APP.dim }}>
            Builds run on the box's own runners; images land in its own registry. The pipeline
            never leaves the house.
          </p>
        </Board>

        {/* Deploy history timeline */}
        <div>
          <div className="flex items-baseline gap-[10px]">
            <h2 className="text-[14px] font-semibold" style={{ color: APP.text }}>
              Deploy history
            </h2>
            <span className="text-[12px]" style={{ color: APP.dim }}>
              only the runs where the digest actually moved
            </span>
          </div>
          <ol
            className="relative mt-[10px] flex flex-col gap-[9px] border-l pl-[18px]"
            style={{ borderColor: APP.border }}
          >
            {HISTORY.map((h) => (
              <li key={h.rev} className="relative">
                <span
                  className="absolute -left-[24px] top-[16px] size-[11px] rounded-full border-2"
                  style={{
                    background: h.current ? APP.accent : APP.bg,
                    borderColor: APP.bg,
                    boxShadow: `0 0 0 1.5px ${h.current ? APP.accent : TONE[h.chip.tone]}`,
                  }}
                />
                <div
                  className="rounded-[12px] border px-[15px] py-[10px]"
                  style={{
                    background: h.current ? `${APP.accent}0f` : APP.panel,
                    borderColor: h.current ? `${APP.accent}66` : APP.hairline,
                  }}
                >
                  <div className="flex items-center gap-[12px]">
                    <code className="font-mono text-[13.5px] font-semibold" style={{ color: APP.text }}>
                      {h.rev}
                    </code>
                    <span className="text-[11.5px]" style={{ color: APP.dim }}>
                      view commit ↗
                    </span>
                    <span className="ml-auto">
                      <Chip tone={h.chip.tone}>{h.chip.label}</Chip>
                    </span>
                  </div>
                  <p className="mt-[3px] font-mono text-[11.5px]" style={{ color: APP.dim }}>
                    {h.sub}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Shell>
  );
}
