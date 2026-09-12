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
          {/* Not "run the app". The repo is the engine and this site; the
              NixOS module that stands it up is still in the author's own
              machine configuration (README, "What's in this repository"), so
              a clone is something to read and take from, not yet something
              to install. Saying otherwise is the first thing a visitor
              disproves, and the rest of the page pays for it. */}
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-muted">
            Read the code, steal the patterns.
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
        {/* The scope note. A visitor who clones expecting a machine finds an
            app, and the disappointment is the site's fault, not the repo's —
            the README says this plainly and the landing page did not say it
            at all. Same quiet register as the docs page's closing line. */}
        <Reveal delay={0.2}>
          <p className="mx-auto mt-6 max-w-lg text-pretty text-[12.5px] leading-relaxed text-dim">
            What's in there: the engine and this site. The NixOS module that stands it up on a
            machine still lives in the author's own configuration — making it importable is the
            next phase of the plan.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
