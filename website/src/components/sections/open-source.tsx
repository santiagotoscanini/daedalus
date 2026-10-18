import { Link } from "@tanstack/react-router";
import { Mark } from "~/components/marks";
import { Reveal } from "~/components/reveal";
import { Command } from "~/components/ui/command";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The close: one line, the two ways in, and the clone for whoever wants to read it first. */
export function OpenSource() {
  return (
    <section aria-labelledby="cta-title" className="cell relative overflow-hidden px-6 py-28 text-center sm:py-36">
      <div className="stage-grid pointer-events-none absolute inset-0" aria-hidden />
      <Reveal className="relative">
        <h2 id="cta-title" className="h-section mx-auto max-w-[40rem] text-[clamp(2.2rem,5vw,3.6rem)]">
          Start with the computer you already have.
        </h2>
        <p className="lede mx-auto mt-5 max-w-[34rem]">
          The engine, the agent and the template a new house starts from, in one repository, MIT licensed.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/" hash="get" className="btn btn-primary">
            Get started
          </Link>
          <Link to="/docs" className="btn btn-ghost">
            Read the docs
          </Link>
        </div>
        <div className="mx-auto mt-10 max-w-md text-left">
          <Command text={`git clone ${REPO}`} label="Clone the repository" />
        </div>
        <a href={REPO} className="mt-6 inline-flex items-center gap-2 text-[13px] text-muted transition-colors hover:text-fg">
          <Mark id="github" size={14} />
          santiagotoscanini/daedalus
        </a>
      </Reveal>
    </section>
  );
}
