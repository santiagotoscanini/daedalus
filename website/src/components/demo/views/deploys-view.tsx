import { APP, AppTile, Btn, Chip, SectionHead, Shell, Table, Tr } from "../chrome";

/** App detail → Deployments, as the app now draws it: the app's head with
 * the exposure ladder (Off, Lab, Public), the builds the box ran for it
 * (one in flight, at the repo's own checks), and the deploys where the
 * image digest actually moved. Mirrors app/src/routes/apps.$name.tsx. */

const BUILD_COLS = "110px 90px minmax(0,1fr) 70px 80px";
const DEPLOY_COLS = "minmax(0,1.3fr) 80px minmax(0,1.5fr) 56px 120px 46px";

const BUILDS: Array<{ state: string; commit: string; by: string; took: string; at: string }> = [
  { state: "succeeded", commit: "4600f0b", by: "push", took: "1m 4s", at: "10h ago" },
  { state: "succeeded", commit: "ed67d03", by: "push", took: "32.8 s", at: "2d ago" },
  { state: "succeeded", commit: "7fe05fb", by: "push", took: "37.4 s", at: "5d ago" },
  { state: "cancelled", commit: "ebcf9d2", by: "push", took: "10.2 s", at: "5d ago" },
  { state: "succeeded", commit: "d3ee838", by: "push", took: "57.0 s", at: "13d ago" },
];

const DEPLOYS: Array<{
  rev: string;
  current?: boolean;
  result: string;
  at: string;
  took: string;
  digest: string;
}> = [
  {
    rev: "4600f0b0",
    current: true,
    result: "success",
    at: "2026-10-06 18:10 · 8h ago",
    took: "3.0 s",
    digest: "9ef9a8964c67",
  },
  {
    rev: "ed67d03a",
    result: "success",
    at: "2026-10-04 11:52 · 2d ago",
    took: "4.1 s",
    digest: "1c0e47b2d9a3",
  },
  {
    rev: "7fe05fb2",
    result: "success",
    at: "2026-10-01 09:37 · 5d ago",
    took: "3.6 s",
    digest: "b84f10e6a2c5",
  },
];

function Seg() {
  const opts = ["Off", "Lab", "Public"];
  return (
    <span className="flex items-center gap-[10px]">
      <span className="text-[12px]" style={{ color: APP.subdued }}>
        Exposure
      </span>
      <span
        className="flex rounded-[9px] border p-[3px] text-[12px]"
        style={{ borderColor: APP.hairline, background: APP.surface }}
      >
        {opts.map((o) => (
          <span
            key={o}
            className="rounded-[6px] px-[10px] py-[3px]"
            style={
              o === "Public"
                ? { background: APP.panel2, color: APP.text, fontWeight: 600 }
                : { color: APP.subdued }
            }
          >
            {o}
          </span>
        ))}
      </span>
    </span>
  );
}

export function DeploysView() {
  return (
    <Shell active="deployments" app="hermes">
      {/* The app's head */}
      <div className="flex items-start gap-[14px]">
        <span
          className="flex size-[46px] items-center justify-center rounded-[11px] border"
          style={{ borderColor: APP.hairline, background: APP.surface }}
        >
          <AppTile name="hermes" size={30} />
        </span>
        <span className="flex min-w-0 flex-col gap-[4px]">
          <span className="text-[24px] font-semibold tracking-[-0.02em]" style={{ color: APP.text }}>
            hermes
          </span>
          <span className="text-[13px]" style={{ color: APP.subdued }}>
            Smart reader: RSS with AI TL;DRs, an opinions library, and a Hacker News lens.
          </span>
          <span className="mt-[3px] flex gap-[22px] font-mono text-[11.5px]" style={{ color: APP.text }}>
            <span>hermes.toscanini.me ↗</span>
            <span>santiagotoscanini/hermes ↗</span>
          </span>
        </span>
        <span className="ml-auto">
          <Seg />
        </span>
      </div>

      {/* Builds */}
      <div className="mt-[26px] flex items-center justify-between">
        <SectionHead title="Builds" />
        <Btn ghost>Build now</Btn>
      </div>
      <p className="-mt-[2px] mb-[10px] text-[12px]" style={{ color: APP.subdued }}>
        Built on this box with Railpack. One build runs at a time; a newer push replaces one still
        waiting in the queue.
      </p>
      <Table cols={BUILD_COLS} head={["State", "Commit", "Requested by", "Took", "Started"]}>
        <Tr cols={BUILD_COLS} first>
          <span>
            <Chip tone="accent">checking</Chip>
          </span>
          <code className="font-mono text-[12px] font-semibold" style={{ color: APP.text }}>
            a91c2e7
          </code>
          <span className="flex items-center gap-[10px] text-[12.5px]" style={{ color: APP.subdued }}>
            push
            <span
              className="relative h-[3px] w-[120px] overflow-hidden rounded-full"
              style={{ background: APP.panel2 }}
            >
              <span
                className="absolute inset-y-0 left-0 w-[58%] rounded-full"
                style={{ background: APP.accent }}
              />
            </span>
          </span>
          <span className="text-right text-[12.5px]" style={{ color: APP.subdued }}>
            21 s
          </span>
          <span className="text-right text-[12.5px]" style={{ color: APP.subdued }}>
            just now
          </span>
        </Tr>
        {BUILDS.map((b) => (
          <Tr key={b.commit + b.at} cols={BUILD_COLS}>
            <span className="text-[12.5px]" style={{ color: APP.subdued }}>
              {b.state === "cancelled" ? <Chip tone="muted">cancelled</Chip> : b.state}
            </span>
            <code className="font-mono text-[12px] font-semibold" style={{ color: APP.text }}>
              {b.commit}
            </code>
            <span className="text-[12.5px]" style={{ color: APP.subdued }}>
              {b.by}
            </span>
            <span className="text-right text-[12.5px]" style={{ color: APP.subdued }}>
              {b.took}
            </span>
            <span className="text-right text-[12.5px]" style={{ color: APP.subdued }}>
              {b.at}
            </span>
          </Tr>
        ))}
      </Table>

      {/* Deploys */}
      <div className="mt-[24px]">
        <SectionHead title="Deploys" note="Only the runs where the image digest actually moved." />
        <Table cols={DEPLOY_COLS} head={["Revision", "Result", "Deployed", "Took", "Digest", "HTTP"]}>
          {DEPLOYS.map((d, i) => (
            <Tr key={d.rev} cols={DEPLOY_COLS} first={i === 0}>
              <span className="flex items-center gap-[10px]">
                <code className="font-mono text-[12px] font-semibold" style={{ color: APP.text }}>
                  {d.rev}
                </code>
                {d.current ? <Chip tone="muted">current</Chip> : null}
              </span>
              <span className="text-[12.5px]" style={{ color: APP.subdued }}>
                {d.result}
              </span>
              <span className="text-[12.5px]" style={{ color: APP.subdued }}>
                {d.at}
              </span>
              <span className="text-[12.5px]" style={{ color: APP.subdued }}>
                {d.took}
              </span>
              <code className="font-mono text-[11.5px]" style={{ color: APP.subdued }}>
                {d.digest}
              </code>
              <span className="text-[12.5px]" style={{ color: APP.subdued }}>
                200
              </span>
            </Tr>
          ))}
        </Table>
      </div>
    </Shell>
  );
}
