import { DemoWindow } from "~/components/demo/demo-window";
import { Reveal } from "~/components/reveal";
import type { Feature } from "~/components/sections/features";

/** One alternating feature row: copy on one side, that page of the app —
 * hand-rebuilt, not screenshotted — on the other. */
export function FeatureRow({ feature, flip }: { feature: Feature; flip: boolean }) {
  return (
    <div
      id={feature.id}
      className={`grid scroll-mt-28 items-center gap-12 lg:gap-20 ${
        flip ? "lg:grid-cols-[3fr_2fr]" : "lg:grid-cols-[2fr_3fr]"
      }`}
    >
      <Reveal className={flip ? "lg:order-2" : ""}>
        <p
          className="font-mono text-[11px] uppercase tracking-[0.18em]"
          style={{ color: feature.color }}
        >
          {feature.kicker}
        </p>
        <h3 className="mt-4 text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.02em]">
          {feature.title}
        </h3>
        <p className="mt-4 text-pretty text-[15px] leading-relaxed text-muted">{feature.body}</p>
      </Reveal>
      <Reveal delay={0.08} className={flip ? "lg:order-1" : ""}>
        <DemoWindow view={feature.view} />
      </Reveal>
    </div>
  );
}
