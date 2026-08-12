import { Reveal } from "~/components/reveal";

/** The big-claim strip: one thesis, no cards, no diagram — the section
 * carries its weight in type alone. */
export function Principles() {
  return (
    <section id="principles" className="scroll-mt-28 py-36">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <Reveal>
          <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[2.75rem] sm:leading-[1.1]">
            The repo is the system.
          </h2>
          <p className="mx-auto mt-7 max-w-2xl text-pretty text-[17px] leading-relaxed text-muted">
            Runtime state is never the source of truth. The flake pins every input, sops encrypts
            every secret in-tree, and the one hand-written registry entry is the app itself —
            because an Apply that broke it would take down the interface you'd use to undo it.
          </p>
          <p className="mt-5 font-mono text-[12px] tracking-wide text-dim">
            Honest pre-release framing: one operator, one box, in production every day.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
