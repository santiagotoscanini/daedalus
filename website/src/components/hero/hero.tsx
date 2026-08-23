import { Link } from "@tanstack/react-router";
import { AppDemo } from "~/components/demo/demo-window";
import { HeroLabyrinth } from "~/components/hero/hero-labyrinth";
import { VENDOR_ROLL_LABEL, VendorRoll } from "~/components/hero/vendor-roll";
import { GitHubLogo } from "~/components/icons";

const REPO = "https://github.com/santiagotoscanini/daedalus";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* The hero artwork: the icon's labyrinth at architectural scale — one
          unbroken ember line drawing itself in from the center. Inline SVG,
          not a baked image; the page-wide grain adds film texture on top and
          HeroLabyrinth adds scroll/pointer parallax. */}
      <div aria-hidden className="absolute inset-x-0 -top-40 flex justify-center sm:-top-64">
        <HeroLabyrinth />
        {/* Scrim: seats the text in a darker pocket at the labyrinth's
            center. Static — it must not move with the parallax. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 58% 52% at 50% 55%, rgba(8,8,10,0.82), rgba(8,8,10,0.3) 62%, transparent 80%)",
          }}
        />
      </div>

      <div className="hero-text relative mx-auto max-w-3xl px-6 pb-20 pt-44 text-center sm:pb-24 sm:pt-56">
        <p className="rise font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
          Open source, on hardware you own
        </p>
        {/* The heading reads once for assistive tech and animates for
            everyone else; see the note in vendor-roll.tsx. No text-balance
            here — the lines are ours, and balancing fights them.

            Fluid, not stepped. The roll clips horizontally (overflow:hidden
            is what makes it a window), so a name too wide for the viewport
            is silently cut rather than overflowing: at a fixed 48px,
            "Google Photos" lost its tail below 430px. The floor here fits
            the longest name at 360px. */}
        <h1 className="rise mt-6 text-[clamp(2.25rem,8.5vw,4.5rem)] font-semibold leading-[1.04] tracking-[-0.03em]">
          <span className="sr-only">{VENDOR_ROLL_LABEL}</span>
          {/* Three fixed lines. The roll gets one to itself at every width:
              the names vary from "AWS" to "Google Photos", and inline they
              would resize the line under them on a loop. On its own line
              the width is free to vary and nothing else moves. */}
          <span aria-hidden className="block">
            <span className="block">Your own</span>
            <VendorRoll />
            <span className="block">On one box.</span>
          </span>
        </h1>
        <p className="rise rise-1 mx-auto mt-6 max-w-lg text-pretty text-[15px] leading-relaxed text-[#b4b4be]">
          Push-to-deploy, managed Postgres, single sign-on, certificates, monitoring and backups.
          The platform you'd otherwise rent.
        </p>
        <div className="rise rise-2 mt-10 flex flex-wrap items-center justify-center gap-3">
          <a href={REPO} className="btn btn-primary h-11 px-5">
            <GitHubLogo size={15} />
            View on GitHub
          </a>
          <Link to="/docs" className="btn btn-ghost h-11 px-5">
            Read the docs
          </Link>
        </div>
        <p className="rise rise-3 mt-7 font-mono text-[11px] tracking-wide text-[#8f8f99]">
          push to main, live in about two minutes
        </p>
      </div>

      {/* The app itself, hand-rebuilt page by page — not a screenshot, so
          every label is real text and the window scales losslessly. */}
      <div className="rise rise-3 relative mx-auto max-w-6xl px-6 pb-28">
        <AppDemo />
      </div>
    </section>
  );
}
