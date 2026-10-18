import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { DemoWindow } from "~/components/demo/demo-window";
import { useFitScale } from "~/components/demo/use-fit-scale";
import { Mark } from "~/components/marks";
import { Messages } from "~/components/messages";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The hero: the mission in one line, then the product doing it.
 *
 * The picture is the control plane's Apps page (a hand-built redraw of the real one, components/demo)
 * in a frame that breaks 40px past the column at 1440, with a messages window over it. In the
 * window, a request goes to a coding agent on the box; in the table, the app it asked for arrives at
 * the top, building, then running. That is how the reference box is driven today.
 *
 * The sequence is CSS with delays, played once: paused until the fonts are in and 40% of the shot
 * (below 1024, of the messages window, which sits under the fold on a phone) is on screen, when
 * the effect below sets data-play. Reduced motion jumps it to the last frame (styles.css), and so
 * does the <noscript> rule, so the prerendered page without script shows the finished frame
 * instead of the first.
 *
 * On a desktop shorter than 860px the text block and the frame sit 40px higher, so at 1440×790 (a
 * 1440×900 laptop with browser chrome) the fold falls between the request in the window and the
 * first reply, never through a line. */

// The reduced-motion rule from styles.css, verbatim. Running as well as instant: a paused 1ms
// animation would hold its first frame, and without script nothing ever sets data-play.
const FINAL_FRAME =
  ".hero-shot :is(.seq,.seq-out,.seq-row,.seq-grow,.seq-life,.seq-wash,.seq-pulse){animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;animation-play-state:running!important}";

export function Hero() {
  const shotRef = useRef<HTMLDivElement>(null);
  useFitScale(shotRef);

  useEffect(() => {
    const el = shotRef.current;
    if (!el) return;
    // On a phone the shot is on screen at load while the window is not, so watch the window there:
    // the conversation and the row it causes play together, when both can be seen.
    const target = window.matchMedia("(min-width: 1024px)").matches ? el : (el.querySelector(".window") ?? el);
    let io: IntersectionObserver | undefined;
    let gone = false;
    void document.fonts.ready.then(() => {
      if (gone) return;
      io = new IntersectionObserver(
        (entries) => {
          // the first callback reports any overlap as intersecting, so read the ratio
          if (entries.some((e) => e.intersectionRatio >= 0.4)) {
            el.setAttribute("data-play", "");
            io?.disconnect();
          }
        },
        { threshold: 0.4 },
      );
      io.observe(target);
    });
    return () => {
      gone = true;
      io?.disconnect();
    };
  }, []);

  return (
    <section className="pt-26 sm:pt-30 lg:pt-34 lg:[@media(max-height:860px)]:pt-24">
      <noscript dangerouslySetInnerHTML={{ __html: `<style>${FINAL_FRAME}</style>` }} />
      <div className="wrap">
        <h1 className="t-display-xl">Software, made for one.</h1>
        <p className="t-lead mt-6 max-w-[690px]">
          daedalus turns the computers you already own into a cloud you can talk to. Say what you need, and it
          writes the change down, builds it and ships it. Every change can be undone in one step.
        </p>
        {/* below 640 the two buttons share a row and the note wraps under them, 16px down (the
            row gap plus mt-1) */}
        <div className="mt-8 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center">
          <Link to="/" hash="get" className="btn btn-primary h-11 sm:h-10">
            Get started
          </Link>
          <a href={REPO} className="btn btn-secondary h-11 sm:h-10">
            <Mark id="github" size={16} />
            View on GitHub
          </a>
          <p className="t-small col-span-2 mt-1 text-ink-4 sm:mt-0 sm:ml-4">
            Open source, MIT licensed. Running one house today.
          </p>
        </div>
      </div>

      {/* Below 1024 the shot keeps to the text's 24 and 40px gutters; the 40px break past the column
          is a desktop gesture. */}
      <div
        ref={shotRef}
        className="hero-shot relative mx-auto mt-10 w-[calc(100%-48px)] sm:w-[calc(100%-80px)] lg:mt-12 lg:w-[min(1280px,calc(100%-32px))]"
      >
        <DemoWindow />
        {/* From 1024 it hangs over the frame 9 design px under the almacen row (which ends at canvas
            y≈283), and from 1440 breaks the frame's right edge by 40px. Below 1024 it overlaps the
            list's foot: below 640 inset 8px from both sides of the shot, so its left edge covers the
            list's tile column whole instead of leaving a sliver of a tile beside it; from 640 at
            most 376px wide, on the right. The wrapper places it and the window zooms with the
            canvas, never under .875 so its type stays beside the product's: a zoom on the
            positioned box would scale its top and right as well. */}
        <div className="relative z-10 mr-2 ml-auto -mt-16 w-[calc(100%-16px)] sm:w-[min(376px,calc(100%-32px))] lg:absolute lg:top-[calc(292px*var(--demo-scale))] lg:right-6 lg:mt-0 lg:mr-0 lg:w-auto min-[90rem]:-right-10">
          <Messages className="lg:w-[376px] lg:origin-top-right lg:[zoom:max(.875,var(--demo-scale))] lg:[@supports_not_(zoom:1)]:[transform:scale(max(.875,var(--demo-scale)))]" />
        </div>
      </div>
    </section>
  );
}
