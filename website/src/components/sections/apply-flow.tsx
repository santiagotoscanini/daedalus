import { useEffect, useRef, useState } from "react";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** How it works, told by the one control that does it: the app's Apply
 * bar, which names the phase the host is actually in and strikes each one
 * through as it passes (app/src/components/apply-bar.tsx, its PHASES). The
 * section pins while the page scrolls through those phases, so reading down
 * the page IS the apply. The phase names are the app's own; the sentences
 * are what nix/stacks/daedalus/host/apply.sh does in each.
 *
 * Reduced motion, and the prerendered page, get the same bar and list
 * still: every phase legible, nothing pinned, nothing struck. */

const PHASES: Array<{ id: string; body: string }> = [
  {
    id: "validating",
    body: "The files the change touches are checked against the short list an Apply may write.",
  },
  {
    id: "writing",
    body: "They go into the configuration repository. The previous bytes are kept aside.",
  },
  { id: "committing", body: "One commit, made as the operator and never as root." },
  { id: "building", body: "nixos-rebuild builds the whole machine from it. Nothing has moved yet." },
  { id: "switching", body: "The machine switches to the new build." },
  { id: "pushing", body: "The commit goes to the remote. git log is the machine's history." },
];

const N = PHASES.length;

export function ApplyFlow() {
  const track = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  // -1: the still state (prerender, reduced motion). 0..N-1: that phase is
  // running. N: applied.
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPinned(true);
    setStep(0);
  }, []);

  useEffect(() => {
    if (!pinned) return;
    const el = track.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      setStep(Math.min(N, Math.floor(p * (N + 0.999))));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [pinned]);

  const applied = step === N;

  return (
    <section id="loop" className="scroll-mt-28 pt-28 sm:pt-36">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="How it works"
          title="Every change is a commit."
          sub="Nothing reaches into the running system. An edit in the app waits in the Apply bar, and then it lands as a commit and a rebuild, or not at all."
        />
      </div>

      <div ref={track} style={pinned ? { height: `${N * 40 + 60}vh` } : undefined}>
        <div
          className={`mx-auto max-w-3xl px-6 ${pinned ? "sticky top-[max(4.5rem,calc(50vh-17.5rem))]" : ""} pb-24 pt-14`}
        >
          {/* The bar, at landing scale */}
          <div
            className={`apply-bar flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-5 py-4 ${applied ? "is-applied" : ""}`}
          >
            <div className="min-w-0 flex-1 text-[14px]">
              {step === -1 ? (
                <>
                  <strong className="font-semibold text-fg">1 app changed</strong>
                  <span className="ml-2.5 text-muted">lintel (stage)</span>
                </>
              ) : applied ? (
                <>
                  <strong className="font-semibold text-fg">Applied</strong>
                  <code className="ml-3 font-mono text-[12.5px] text-muted">
                    a91c2e7 apps: lintel (stage)
                  </code>
                </>
              ) : (
                <>
                  <strong className="font-semibold text-fg">Applying</strong>
                  <span className="ml-3 font-mono text-[12px] text-accent sm:hidden">
                    {PHASES[step]?.id}
                  </span>
                  <span className="ml-3 hidden font-mono text-[12px] sm:inline">
                    {PHASES.map((p, i) => (
                      <span
                        key={p.id}
                        className={`mr-3 ${i < step ? "text-dim line-through" : i === step ? "text-accent" : "text-dim/60"}`}
                      >
                        {p.id}
                      </span>
                    ))}
                  </span>
                </>
              )}
            </div>
            {applied ? null : (
              <span
                className={`rounded-lg px-3.5 py-1.5 text-[13px] font-semibold ${step >= 0 ? "bg-white/10 text-muted" : "bg-fg text-app"}`}
              >
                {step >= 0 ? "Applying" : "Apply"}
              </span>
            )}
          </div>

          {/* The phases, one line each */}
          <ol className="mt-10 border-t border-hairline">
            {PHASES.map((p, i) => {
              const state = step === -1 ? "still" : i < step ? "done" : i === step ? "now" : "next";
              return (
                <li
                  key={p.id}
                  data-state={state}
                  className="phase grid grid-cols-[7.5rem_1fr] items-baseline gap-4 border-b border-hairline py-3.5 sm:grid-cols-[9rem_1fr] sm:gap-8"
                >
                  <span className="phase-name font-mono text-[12.5px]">{p.id}</span>
                  <span className="phase-body text-pretty text-[14px] leading-relaxed">
                    {p.body}
                  </span>
                </li>
              );
            })}
          </ol>

          <Reveal>
            <p className="mt-7 max-w-2xl text-pretty text-[13px] leading-relaxed text-dim">
              A build that fails puts the files back before anything switched. A switch that fails
              is tried once more, then the files are restored, the revert is committed and the
              machine rebuilds to where it was. The bar shows the first error, not the rollback's.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
