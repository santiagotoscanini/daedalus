import { Logo } from "~/components/logo";
import { type MarkId, Mark } from "~/components/marks";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** Why at home, and the house as it is: the reference box and the machines joined to it, drawn as a
 * plain diagram (site/nodes.json: a gaming PC with the GPU and two Macs, each with the agent), with
 * requests moving along the links. Then the figures of that house. */

const NODES: Array<{ id: string; x: number; y: number; name: string; note: string; mark?: MarkId }> = [
  { id: "pc", x: 82, y: 24, name: "Gaming PC", note: "GPU · models", mark: "windows" },
  { id: "mac", x: 18, y: 24, name: "MacBook", note: "agent", mark: "apple" },
  { id: "mac2", x: 18, y: 78, name: "Another Mac", note: "agent", mark: "apple" },
  { id: "phone", x: 82, y: 78, name: "Your phone", note: "anywhere" },
];

const W = 640;
const H = 420;
const path = (x: number, y: number) => {
  const sx = 320;
  const sy = 210;
  const ex = (x / 100) * W;
  const ey = (y / 100) * H;
  return `M${sx} ${sy} C${sx + (ex - sx) * 0.5} ${sy} ${ex - (ex - sx) * 0.5} ${ey} ${ex} ${ey}`;
};

const STATS: Array<[string, string]> = [
  ["4", "machines acting as one"],
  ["9", "apps, each made for someone"],
  ["2 × 16 TB", "mirrored, snapshots every hour"],
  ["$0", "hosting bill"],
];

export function House() {
  return (
    <section id="home" aria-labelledby="home-title" className="cell scroll-mt-16">
      <div className="grid gap-12 px-6 py-24 sm:px-12 sm:py-32 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
        <div>
          <SectionHeading
            id="home-title"
            label="Why at home"
            title="The next computer in every home is a server."
            sub="Cheap, quiet and as ordinary as a microwave, with the models already on it. A model small enough to live in the house can answer most of what we used to ask a search engine, and a capable one fits on a gaming card."
          />
          <Reveal delay={0.06}>
            <ul className="mt-8 space-y-3 text-[15px] text-body">
              {[
                "It keeps working when the internet doesn’t.",
                "Your apps, your data and your models stay yours.",
                "Trying something costs nothing.",
              ].map((t) => (
                <li key={t} className="flex items-baseline gap-3">
                  <span className="text-status-ok" aria-hidden>
                    ✓
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </Reveal>
        </div>

        <Reveal delay={0.08}>
          <div
            className="relative aspect-[64/42] w-full overflow-hidden rounded-xl border border-line bg-panel"
            role="img"
            aria-label="The reference house: the box in the middle, joined to a gaming PC with a GPU, two Macs and a phone, with requests moving between them."
          >
            <div className="stage-grid absolute inset-0" aria-hidden />
            <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" aria-hidden>
              {NODES.map((n, i) => (
                <g key={n.id}>
                  <path id={`link-${n.id}`} d={path(n.x, n.y)} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="1" />
                  <circle r="2.6" fill="#ededef">
                    <animateMotion dur={`${3.2 + i * 0.7}s`} repeatCount="indefinite" begin={`${i * 0.9}s`} keyPoints={i % 2 ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear">
                      <mpath href={`#link-${n.id}`} />
                    </animateMotion>
                  </circle>
                </g>
              ))}
            </svg>
            {NODES.map((n) => (
              <div
                key={n.id}
                className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-2 py-1.5 sm:gap-2.5 sm:px-3 sm:py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)]"
                style={{ left: `${n.x}%`, top: `${n.y}%` }}
              >
                <span className="grid size-7 place-items-center rounded-md border border-line bg-panel text-muted">
                  {n.mark ? (
                    <Mark id={n.mark} size={13} />
                  ) : (
                    <svg width="12" height="14" viewBox="0 0 12 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                      <rect x="1" y="1" width="10" height="16" rx="2.2" />
                    </svg>
                  )}
                </span>
                <span>
                  <span className="block text-[12.5px] font-medium leading-tight">{n.name}</span>
                  <span className="hidden text-[11px] leading-tight text-muted-2 sm:block">{n.note}</span>
                </span>
              </div>
            ))}
            <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-3 rounded-xl border border-line-2 bg-surface px-4 py-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.9)]">
              <Logo size={30} />
              <span>
                <span className="block text-[14px] font-semibold leading-tight">The box</span>
                <span className="block text-[11.5px] leading-tight text-muted-2">NixOS · daedalus</span>
              </span>
            </div>
          </div>
        </Reveal>
      </div>

      <dl className="grid grid-cols-2 border-t border-hairline lg:grid-cols-4">
        {STATS.map(([v, l], i) => (
          <div
            key={l}
            className={`flex flex-col border-hairline px-6 py-8 sm:px-12 ${i % 2 === 0 ? "border-r" : ""} ${i === 1 ? "lg:border-r" : ""} ${i < 2 ? "max-lg:border-b" : ""}`}
          >
            <dt className="order-2 mt-1 text-[13.5px] text-muted">{l}</dt>
            <dd className="order-1 text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.04em]">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
