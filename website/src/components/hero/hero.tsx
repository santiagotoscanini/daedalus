import { Link } from "@tanstack/react-router";
import { AppDemo } from "~/components/demo/demo-window";
import { HeroLabyrinth } from "~/components/hero/hero-labyrinth";
import { VENDOR_ROLL_LABEL, VendorRoll } from "~/components/hero/vendor-roll";

const REPO = "https://github.com/santiagotoscanini/daedalus";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* The hero artwork: the mark's labyrinth built into walls and laid
          down in perspective behind the headline (hero-labyrinth.tsx). */}
      <div aria-hidden className="absolute inset-x-0 -top-24 flex justify-center sm:-top-40">
        <HeroLabyrinth />
        {/* Scrim: seats the text in a darker pocket. Static, it must not
            move with the plan. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 50% 46% at 50% 52%, rgba(8,8,10,0.86), rgba(8,8,10,0.35) 60%, transparent 80%)",
          }}
        />
      </div>

      <div className="hero-text relative mx-auto max-w-3xl px-6 pb-16 pt-40 text-center sm:pb-20 sm:pt-52">
        <p className="rise font-mono text-[11px] uppercase tracking-[0.2em] text-muted-2">
          Open source · NixOS
        </p>
        {/* Fluid, not stepped: the roll clips horizontally, so a name too
            wide for the viewport would be cut rather than overflow. The floor
            fits the longest name at 360px. */}
        <h1 className="rise mt-6 text-[clamp(2.4rem,9vw,5rem)] font-semibold leading-[1.02] tracking-[-0.035em]">
          <span className="sr-only">{VENDOR_ROLL_LABEL}</span>
          <span aria-hidden className="block">
            <span className="block">Your own</span>
            <VendorRoll />
          </span>
        </h1>
        {/* The one paragraph that says what this IS: the headline names no
            category. */}
        <p className="rise rise-1 mx-auto mt-7 max-w-[34rem] text-pretty text-[clamp(15px,1.6vw,17px)] leading-relaxed text-[#b4b4be]">
          A control plane for one machine you own. It builds and deploys your apps, gives them a
          database and a login when they ask for one, and watches all of it. Every change it makes is a
          commit to the machine's NixOS configuration.
        </p>
        <div className="rise rise-2 mt-10 flex flex-wrap items-center justify-center gap-3">
          <a href={REPO} className="btn btn-primary h-11 px-5">
            View on GitHub
          </a>
          <Link to="/" hash="get" className="btn btn-ghost h-11 px-5">
            Get it
          </Link>
        </div>
      </div>

      {/* The app itself, hand-rebuilt page by page: not a screenshot, so
          every label is real text and the window scales losslessly. */}
      <div className="rise rise-3 relative mx-auto max-w-6xl px-4 pb-28 sm:px-6">
        <AppDemo />
      </div>
    </section>
  );
}
