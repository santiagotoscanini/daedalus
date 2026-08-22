import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** The apply flow, set as what it literally is: a commit trail. Five
 * stations on one unbroken vertical thread — no card grid, the git-log
 * form IS the section's argument. */

const STEPS = [
  {
    hash: "e21c04f",
    title: "Change",
    body: "Flip a setting in the UI. The database is the working copy.",
    color: "#4493f8",
  },
  {
    hash: "9b7d3a1",
    title: "Export",
    body: "The registry renders to a committed JSON contract.",
    color: "#a78bfa",
  },
  {
    hash: "f04e88d",
    title: "Rebuild",
    body: "NixOS converges the whole machine to the new declaration.",
    color: "#e2795a",
  },
  {
    hash: "c5a9612",
    title: "Verify",
    body: "A failed rebuild reverts itself. The bad state never lands.",
    color: "#d9a441",
  },
  {
    hash: "77b0cde",
    title: "Push",
    body: "The commit names who changed what, and why. Forever.",
    color: "#4ea87a",
  },
];

export function Loop() {
  return (
    <section id="loop" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="The apply flow"
          title="Every change is a commit."
          sub="Nothing reaches into the running system. A change in the UI becomes a contract, a commit and a rebuild — or it becomes nothing at all."
        />

        <div className="relative mx-auto mt-16 max-w-xl">
          {/* The thread: one unbroken line the five commits hang on, with an
              ember pulse walking it top to bottom. */}
          <div className="thread-rail absolute bottom-3 left-[5px] top-3" aria-hidden />

          <ol className="space-y-10">
            {STEPS.map((s, i) => (
              <li key={s.hash} className="relative pl-10">
                {/* The commit dot, seated on the thread. A direct child of
                    the li — inside Reveal, the reveal transform would
                    change its containing block and pull it off the rail. */}
                <span
                  className="absolute left-0 top-[5px] block size-[11px] rounded-full border-2 bg-app"
                  style={{ borderColor: s.color, boxShadow: `0 0 12px ${s.color}66` }}
                  aria-hidden
                />
                <Reveal delay={i * 0.05}>
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="font-mono text-[12px] text-dim">{s.hash}</span>
                    <h3 className="text-[16px] font-medium">{s.title}</h3>
                  </div>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{s.body}</p>
                </Reveal>
              </li>
            ))}
          </ol>

          <Reveal delay={0.3}>
            <p className="mt-12 pl-10 font-mono text-[11px] tracking-wide text-dim">
              git log --oneline · the whole machine, every change, forever
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
