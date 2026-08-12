import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "~/components/hero/hero";
import { FeatureRow } from "~/components/sections/feature-row";
import { FEATURES } from "~/components/sections/features";
import { Loop } from "~/components/sections/loop";
import { OpenSource } from "~/components/sections/open-source";
import { Principles } from "~/components/sections/principles";
import { SectionHeading } from "~/components/ui/section-heading";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main id="main">
      <Hero />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <Loop />
      <section id="features" className="scroll-mt-28 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <SectionHeading
            kicker="What it does"
            title="One app runs the box."
            sub="Deploys, monitoring, isolation, recovery — each one a view in daedalus, each one backed by the same declared truth."
          />
          <div className="mt-24 flex flex-col gap-36">
            {FEATURES.map((f, i) => (
              <FeatureRow key={f.id} feature={f} flip={i % 2 === 1} />
            ))}
          </div>
        </div>
      </section>
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <Principles />
      <OpenSource />
    </main>
  );
}
