import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { GitHubLogo } from "~/components/icons";
import { Labyrinth } from "~/components/labyrinth";
import { Reveal } from "~/components/reveal";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const CLONE = `git clone ${REPO}`;

/** Closing CTA: the labyrinth returns, mirrored — the same unbroken line
 * rising from below the horizon to close the page the way it opened. */
export function OpenSource() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CLONE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the text is
      // selectable either way.
    }
  };

  return (
    <section id="oss" className="relative scroll-mt-28 overflow-hidden py-36">
      {/* Mask-faded upward so only the spiral's crown breaks the surface —
          same technique as the hero's radial melt, aimed at the horizon. */}
      <div
        aria-hidden
        className="absolute inset-x-0 -bottom-72 flex justify-center overflow-hidden"
        style={{
          maskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 72%)",
          WebkitMaskImage: "linear-gradient(to top, rgba(0,0,0,0.9), transparent 72%)",
        }}
      >
        <Labyrinth className="w-[64rem] max-w-none flex-none -scale-y-100 select-none opacity-[0.18]" />
      </div>

      <div className="relative mx-auto max-w-2xl px-6 text-center">
        <Reveal>
          <h2 className="text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[2.75rem]">
            Follow the thread.
          </h2>
          {/* The clone is for reading. Running it is the section above: a
              host imports the engine as a flake input and starts from the
              template. This one is for the visitor who wants to see how it
              is built before deciding to. */}
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-muted">
            Read the code. Every module, the control plane and this site are one repository.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a href={REPO} className="btn btn-primary h-11 px-5">
              <GitHubLogo size={15} />
              View on GitHub
            </a>
            <Link to="/docs" className="btn btn-ghost h-11 px-5">
              Read the docs
            </Link>
          </div>
        </Reveal>
        <Reveal delay={0.14}>
          {/* max-w-xl, not md: the command is 53 characters of 12.5px mono
              and md cut it mid-repo-name — "github.com/santiagotoscanin" —
              with no scrollbar to say it had. It still scrolls on a phone,
              where nothing fits and the copy button is the real affordance. */}
          <div className="card mx-auto mt-12 flex max-w-xl items-center justify-between gap-3 px-4 py-3">
            <code className="select-all overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-muted">
              {CLONE}
            </code>
            {/* aria-live, because the only feedback this button gives is its
                own label changing, and a changed accessible name is not
                announced on its own. Without it the confirmation exists for
                sighted visitors only. */}
            <button
              type="button"
              onClick={copy}
              aria-live="polite"
              className="shrink-0 rounded-md px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:bg-white/5 hover:text-accent"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </Reveal>
        {/* The scope note, kept honest as the scope moved: the modules are in
            the repository since 2026-09-21 and a host imports them, but no
            release is tagged yet, so what a clone gets is main. Same quiet
            register as the docs page's closing line. */}
        <Reveal delay={0.2}>
          <p className="mx-auto mt-6 max-w-lg text-pretty text-[12.5px] leading-relaxed text-dim">
            What's in there: the NixOS modules a host imports, the control plane they run, the
            template a new host starts from, and this site. Pre-release — there is no tagged
            version yet, so a clone follows main.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
