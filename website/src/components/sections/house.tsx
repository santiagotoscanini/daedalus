import type { CSSProperties } from "react";

import { APP } from "~/components/demo/chrome";
import { Logo } from "~/components/logo";
import { Mark, type MarkId } from "~/components/marks";
import { SectionHeader } from "~/components/ui/section-header";

/** Why at home: the case for the house, beside a crop of the Machines page as the reference house
 * has it (site/nodes.json: the box, a gaming PC with the GPU, two Macs joined through the agent).
 * The crop is a still picture, so it has no status column and no dots: nothing on it claims to be
 * live. Below 640px the table keeps one column, the role under each name and the OS as the mark, and
 * the footer drops the snapshot clause so it stays one line beside the bill. */

const MACHINES: Array<{ name: string; role: string; os: string; mark: MarkId | null }> = [
  { name: "The box", role: "Builds and serves 9 apps, their databases and the registry", os: "NixOS", mark: null },
  { name: "Gaming PC", role: "Runs the house’s models on its GPU", os: "Windows", mark: "windows" },
  { name: "MacBook", role: "Joins through the agent", os: "macOS", mark: "apple" },
  { name: "Another Mac", role: "Joins through the agent", os: "macOS", mark: "apple" },
];

/** The case itself, unmarked, each under its own rule in the column beside the crop. */
const SENTENCES = [
  "It keeps working when the internet doesn’t.",
  "Your apps, your data and your models stay yours.",
  "Trying something costs nothing.",
];

/** Product type, set inline: arbitrary `text-[Npx]` classes belong to components/demo/ alone. */
const txt = (size: number, lineHeight: number, weight: number, color: string): CSSProperties => ({
  fontSize: size,
  lineHeight: `${lineHeight}px`,
  fontWeight: weight,
  color,
});

const COLS = "grid grid-cols-[minmax(0,1fr)] gap-x-[14px] px-5 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_104px]";

export function House() {
  return (
    <section id="home" aria-labelledby="home-title" className="groove py-18 sm:py-24 lg:py-28">
      <div className="wrap">
        <SectionHeader
          id="home-title"
          title="The next computer in every home is a server."
          lead="Cheap, quiet and as ordinary as a microwave, with the models already on it. A model small enough to live in the house can answer most of what we used to ask a search engine, and a capable one fits on a gaming card."
        />

        <div className="grid-12 mt-10 items-start lg:mt-16">
          <div
            data-product=""
            role="img"
            aria-label="The Machines page in daedalus, four machines. The box, on NixOS, builds and serves 9 apps, their databases and the registry. A gaming PC on Windows runs the house’s models on its GPU. A MacBook and another Mac join through the agent. Storage is two 16 TB disks, mirrored, with snapshots every hour, and the hosting bill is $0."
            className="fragment overflow-hidden lg:col-span-8"
          >
            <div className="flex h-12 items-center justify-between gap-4 border-b px-5" style={{ borderColor: APP.hairline }}>
              <p style={txt(14, 20, 600, APP.text)}>Machines</p>
              <p style={txt(12, 16, 400, APP.subdued)}>4 machines</p>
            </div>

            <div
              className={`${COLS} h-9 items-center border-b`}
              style={{ ...txt(11.5, 16, 500, APP.subdued), borderColor: APP.hairline }}
            >
              <span>Machine</span>
              <span className="max-sm:hidden">Role</span>
              <span className="max-sm:hidden">OS</span>
            </div>

            {MACHINES.map((m, i) => (
              <div
                key={m.name}
                className={`${COLS} min-h-14 items-center py-2.5 ${i ? "border-t" : ""}`}
                style={{ borderColor: APP.hairline }}
              >
                <div className="flex min-w-0 items-center gap-[10px]">
                  <span className="flex w-[18px] shrink-0 justify-center" style={{ color: APP.subdued }}>
                    {m.mark ? <Mark id={m.mark} size={14} /> : <Logo size={18} />}
                  </span>
                  <div className="min-w-0">
                    <p style={txt(13.5, 20, 600, APP.text)}>{m.name}</p>
                    <p className="sm:hidden" style={txt(12, 16, 400, APP.subdued)}>
                      {m.role}
                    </p>
                  </div>
                </div>
                <p className="max-sm:hidden" style={txt(13, 18, 400, APP.subdued)}>
                  {m.role}
                </p>
                <p className="max-sm:hidden" style={txt(13, 18, 400, APP.subdued)}>
                  {m.os}
                </p>
              </div>
            ))}

            <div
              className="flex min-h-11 items-center justify-between gap-4 border-t px-5 py-3"
              style={{ ...txt(12, 16, 400, APP.subdued), background: APP.rail, borderColor: APP.hairline }}
            >
              <p className="tnum min-w-0">
                2{" × "}16 TB mirrored<span className="max-sm:hidden"> · snapshots every hour</span>
              </p>
              <p className="flex shrink-0 items-baseline gap-2">
                Hosting bill
                <span className="tnum" style={txt(13, 16, 600, APP.text)}>
                  $0
                </span>
              </p>
            </div>
          </div>

          <div className="mt-10 flex flex-col gap-4 lg:col-span-3 lg:col-start-10 lg:mt-0">
            {SENTENCES.map((s) => (
              <p key={s} className="t-body border-t border-edge-1 pt-4 text-ink-2">
                {s}
              </p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
