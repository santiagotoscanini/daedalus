import { Reveal } from "~/components/reveal";

/** The objection every self-hosting project meets, quoted, and the answer the whole project rests on. */
export function Statement() {
  return (
    <section aria-label="The objection, and the answer" className="cell px-6 py-24 sm:py-32">
      <Reveal className="mx-auto max-w-[52rem] text-center">
        <figure>
          <blockquote className="text-[clamp(1.6rem,3.4vw,2.6rem)] font-medium leading-[1.18] tracking-[-0.03em] text-body">
            “People don’t want to run their own servers, and never will.”
          </blockquote>
          <figcaption className="mt-6 flex items-center justify-center gap-3 text-[14px] text-muted">
            <span className="h-px w-6 bg-line-2" aria-hidden />
            Moxie Marlinspike, 2022
          </figcaption>
        </figure>
        <p className="h-section mx-auto mt-16 max-w-[46rem] text-[clamp(1.75rem,3.6vw,2.75rem)]">
          <span className="text-muted">If talking is the only interface you need, </span>
          running your own computer stops being a skill.
        </p>
      </Reveal>
    </section>
  );
}
