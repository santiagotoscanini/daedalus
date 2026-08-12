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
          <p className="mx-auto mt-5 max-w-lg text-pretty text-[15px] leading-relaxed text-muted">
            Read the code, steal the patterns, or run the whole thing.
          </p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a href={REPO} className="btn btn-primary h-11 px-5">
              <GitHubLogo size={15} />
              View on GitHub
            </a>
            <a href={`${REPO}/tree/main/docs`} className="btn btn-ghost h-11 px-5">
              Read the docs
            </a>
          </div>
        </Reveal>
        <Reveal delay={0.14}>
          <div className="card mx-auto mt-12 flex max-w-md items-center justify-between gap-3 px-4 py-3">
            <code className="select-all overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-muted">
              {CLONE}
            </code>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 rounded-md px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:bg-white/5 hover:text-accent"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
