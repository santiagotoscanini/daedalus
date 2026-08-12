import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";

const STEPS = [
  {
    n: "01",
    title: "Change",
    body: "Flip a setting in the UI. The database is the working copy.",
    color: "#4493f8",
  },
  {
    n: "02",
    title: "Export",
    body: "The registry renders to a committed JSON contract.",
    color: "#a78bfa",
  },
  {
    n: "03",
    title: "Rebuild",
    body: "NixOS converges the whole machine to the new declaration.",
    color: "#e2795a",
  },
  {
    n: "04",
    title: "Verify",
    body: "A failed rebuild reverts itself. The bad state never lands.",
    color: "#d9a441",
  },
  {
    n: "05",
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
        <div className="relative mt-16">
          {/* The wire the five stages hang on — an ember pulse runs the flow
              left to right. Visible only in the gaps between cards. */}
          <div className="pipeline-wire hidden lg:block" aria-hidden />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 0.05}>
                <SpotlightCard className="card h-full p-5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-white/[0.12]">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-dim">{s.n}</span>
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: s.color, boxShadow: `0 0 10px ${s.color}80` }}
                      aria-hidden
                    />
                  </div>
                  <h3 className="mt-5 text-[15px] font-medium">{s.title}</h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{s.body}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
