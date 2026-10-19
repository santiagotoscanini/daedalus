import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { AppMark } from "~/components/demo/app-marks";
import { ArrowUpRight } from "~/components/icons";
import { motionOn } from "~/components/landing/motion";
import { Header, Section } from "~/components/landing/section";

/** Made for one (#made): why nobody makes the app a family wants, then five real ones that were
 * made, each for a few people. Each is shown in use, never by its home page: public/apps/*.jpg,
 * 1920×1200, holding demo data only (each entry below says where its picture comes from). That no
 * two of them look alike is the point, so the pictures are plain: no browser chrome, no frame, only
 * a hairline.
 *
 * The gallery is a native scroll-snap row, full-bleed, so momentum, swiping and the no-JS fallback
 * come from the browser and nothing is ever scrolled by script on its own. One slide is active: the
 * one whose centre is nearest the row's centre. It sits at full strength with its caption; the
 * others wait at .4 with theirs hidden, and a click on one brings it to the centre. Dots and two
 * paddles under the row do the same from the keyboard or a mouse. The dots are one tab stop, the
 * current dot, which Left and Right move along; the focused row takes Left and Right as well. All
 * of that dimming and hiding is scoped to html[data-js] (made.css), so without script, or if the app
 * never hydrates, every slide and caption shows. It never advances by itself. */

const APPS = [
  {
    // the reading step of sankofa's landing, its own words left out: a public-domain letter read
    // line by line beside the app's transcription panel, as the landing redraws it (the scan line's
    // two stubs outside the paper are painted out)
    id: "sankofa",
    forWhom: "For friends writing history PhDs at Harvard.",
    what: "Reads, corrects and indexes 19th-century handwritten documents.",
    alt: "sankofa in use: a handwritten letter from 1863 being read line by line. Beside it, the transcription shows each line’s handwriting above its typed text, with the misread words struck through and corrected.",
  },
  {
    // the app itself, signed in to a throwaway copy holding its sample scan (no one's real rooms);
    // the test account's address in the bar is painted out
    id: "lintel",
    forWhom: "For a move to a new city.",
    what: "Scan an apartment with your phone and furnish it before you arrive. Built in five hours at Vercel’s Fast Forward hackathon, where it won.",
    alt: "lintel in use: a scanned studio drawn in 3D in the browser, with its door, two windows and furniture, and a sofa the phone captured in colour. Beside it, the room’s measurements: 5.40 by 4.20 metres.",
  },
  {
    // the reader from hermes's landing (its demo pane, lifted out in the app's dark theme), with
    // the read-aloud bar open on a public-domain text under its real author: the first week of
    // Charles Dudley Warner's "My Summer in a Garden" (1870, Project Gutenberg)
    id: "hermes",
    forWhom: "For one reader.",
    what: "The writers and documents they care about, read aloud in a cloned voice.",
    alt: "hermes in use: Charles Dudley Warner’s “My Summer in a Garden” open in the reader on a dark page, with a four-point summary above the text and the read-aloud bar playing in a cloned voice.",
  },
  {
    // the itinerary's day card from voyra's landing, drawn by hand from the real editor, over the
    // landing's own map of the trip (its atlas, in the form it takes under reduced motion): the
    // first day of the sample trip to Japan, with its flight, its stay and two stops
    id: "voyra",
    forWhom: "For a family trip.",
    what: "One plan for the whole trip, easy to share with everyone coming.",
    alt: "voyra in use: the first day of a ten-day trip to Japan, with its flight, its hotel and two stops and their times, over a map of Japan that shows the flight into Tokyo and Kyoto beyond it.",
  },
  {
    // the Pulse window from anansi's landing, filled in for an invented person; the window is
    // cropped above the account chip, so only the groups end the sidebar
    id: "anansi",
    forWhom: "For a person and their therapist.",
    what: "A quiet place to understand yourself.",
    alt: "anansi in use: a person’s week in a journal, with three entries written in and, beside them, what is coming up: an essay promised, a birthday and a cabin to book.",
  },
] as const;


const LAST = APPS.length - 1;

export function Made() {
  return (
    <Section id="made">
      <Header
        title="The apps no company will make for your family."
        intro="Software goes where the numbers are, and a family is a market of one. Now yours can ask for its own."
      />
      <div className="wrap">
        <p className="t-transition made-transition">
          Pinch is an example. These five are real, each made with daedalus for a few people.
        </p>
      </div>
      <Gallery />
    </Section>
  );
}

function Gallery() {
  const track = useRef<HTMLDivElement>(null);
  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const [active, setActive] = useState(0);
  const current = useRef(0);
  // while a click, a dot or a key glides to a slide, the slides it passes do not become active
  const target = useRef<number | null>(null);
  const release = useRef(0);

  const show = (i: number) => {
    current.current = i;
    setActive(i);
  };

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const mid = el.scrollLeft + el.clientWidth / 2;
      let best = 0;
      let dist = Infinity;
      Array.from(el.children).forEach((s, i) => {
        const slide = s as HTMLElement;
        const d = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - mid);
        if (d < dist) {
          dist = d;
          best = i;
        }
      });
      if (target.current !== null) {
        if (best !== target.current) return;
        target.current = null;
      }
      if (best !== current.current) show(best);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // a hand on the row takes over from a glide in progress
    const onHand = () => {
      target.current = null;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("pointerdown", onHand, { passive: true });
    el.addEventListener("wheel", onHand, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(release.current);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("pointerdown", onHand);
      el.removeEventListener("wheel", onHand);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  /** Bring slide i to its snap position: the centre, or on phones the start (behind the 16px
   * scroll padding), read from the slide's own snap alignment so the CSS stays the one source. */
  const go = (i: number) => {
    const el = track.current;
    const slide = el?.children[i] as HTMLElement | undefined;
    if (!el || !slide) return;
    const start = getComputedStyle(slide).scrollSnapAlign.includes("start");
    const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft) || 0;
    const left = start ? slide.offsetLeft - pad : slide.offsetLeft + slide.offsetWidth / 2 - el.clientWidth / 2;
    target.current = i;
    show(i);
    // the lock is only for the glide; if anything stops it short, the row's own position wins
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => {
      target.current = null;
      el.dispatchEvent(new Event("scroll"));
    }, 1000);
    el.scrollTo({ left, behavior: motionOn() ? "smooth" : "auto" });
  };

  /** The slide `by` steps from the one shown (or the one being glided to), or null at an end. */
  const from = (by: number) => {
    const at = target.current ?? current.current;
    const next = Math.min(LAST, Math.max(0, at + by));
    return next === at ? null : next;
  };

  const step = (by: number) => {
    const next = from(by);
    if (next !== null) go(next);
  };

  /** Left, Right, Home and End as a slide index, or null for any other key. */
  const keyTo = (key: string) => {
    if (key === "ArrowRight") return from(1) ?? -1;
    if (key === "ArrowLeft") return from(-1) ?? -1;
    if (key === "Home") return 0;
    if (key === "End") return LAST;
    return null;
  };

  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const to = keyTo(e.key);
    if (to === null) return;
    e.preventDefault();
    if (to >= 0 && to !== (target.current ?? current.current)) go(to);
    // from the caption link, which is about to hide: the row keeps the focus, ringing the new slide
    if (e.target !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
  };

  // roving focus: the current dot is the one tab stop, and the arrow keys carry focus along the row
  const onDotKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const to = keyTo(e.key);
    if (to === null) return;
    e.preventDefault();
    if (to < 0) return;
    if (to !== (target.current ?? current.current)) go(to);
    dots.current[to]?.focus();
  };

  return (
    <div className="made-gallery after-header">
      <div
        ref={track}
        className="made-track"
        role="region"
        aria-roledescription="carousel"
        aria-label="Apps made with daedalus"
        tabIndex={0}
        onKeyDown={onTrackKey}
      >
        {APPS.map((app, i) => (
          <div
            key={app.id}
            className="made-slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${APPS.length}: ${app.id}`}
            data-active={i === active ? "" : undefined}
            onClick={() => {
              if (i !== current.current) go(i);
            }}
          >
            <div className="made-shot">
              <img
                src={`/apps/${app.id}.jpg`}
                srcSet={`/apps/${app.id}.jpg 1920w`}
                sizes="(min-width: 1024px) 880px, (min-width: 640px) 86vw, calc(100vw - 56px)"
                width={1920}
                height={1200}
                alt={app.alt}
                loading={i === 0 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
              />
            </div>
            <a className="made-cap" href={`https://${app.id}.toscanini.me`}>
              <span className="made-cap-head">
                <AppMark name={app.id} size={20} />
                <span className="t-name made-name">{app.id}</span>
                <ArrowUpRight size={12} className="made-out" />
              </span>
              <span className="t-for made-for">{app.forWhom}</span>
              <span className="made-what">{app.what}</span>
            </a>
          </div>
        ))}
      </div>

      <div className="made-controls">
        <div className="made-dots" role="group" aria-label="Choose an app">
          {APPS.map((app, i) => (
            <button
              key={app.id}
              ref={(b) => {
                dots.current[i] = b;
              }}
              type="button"
              className="made-dot"
              aria-label={`Show ${app.id}`}
              aria-current={i === active ? "true" : undefined}
              tabIndex={i === active ? 0 : -1}
              onKeyDown={onDotKey}
              onClick={() => go(i)}
            />
          ))}
        </div>
        <div className="made-arrows">
          <button
            type="button"
            className="made-arrow"
            aria-label="Previous app"
            aria-disabled={active === 0 ? "true" : undefined}
            onClick={() => step(-1)}
          >
            <Chevron left />
          </button>
          <button
            type="button"
            className="made-arrow"
            aria-label="Next app"
            aria-disabled={active === LAST ? "true" : undefined}
            onClick={() => step(1)}
          >
            <Chevron />
          </button>
        </div>
      </div>
    </div>
  );
}

/** The paddles' chevron, 14px: a 4×8 angle on whole pixels, centred on its own box (icons.tsx's
 * ChevronRight is drawn for 10px beside small text; scaled up, its stroke would thicken). */
function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="block"
    >
      <path d={left ? "M9 3 5 7l4 4" : "M5 3l4 4-4 4"} />
    </svg>
  );
}
