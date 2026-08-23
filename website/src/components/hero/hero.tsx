import { Link } from "@tanstack/react-router";
import { AppDemo } from "~/components/demo/demo-window";
import { HeroLabyrinth } from "~/components/hero/hero-labyrinth";
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
        <h1 className="rise mt-6 text-balance text-5xl font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[4.5rem]">
          Build yourself
          <br />
          <span className="text-gradient-ember">a cloud.</span>
        </h1>
        <p className="rise rise-1 mx-auto mt-7 max-w-xl text-pretty text-[17px] leading-relaxed text-[#c6c6cd]">
          The platform you'd otherwise rent: push-to-deploy, managed Postgres, single sign-on,
          certificates, monitoring, backups. Your own Vercel, your own AWS, running on a machine you
          own.
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
