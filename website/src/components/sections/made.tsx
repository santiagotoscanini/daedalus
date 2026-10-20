import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { AppMark } from "~/components/demo/app-marks";
import { ArrowUpRight } from "~/components/icons";
import { motionOn } from "~/components/landing/motion";
import { Header, Section } from "~/components/landing/section";

/** Made for one (#made): why nobody makes the app a family wants, then five real ones that were
 * made, each for a few people. Each is shown in use, never by its home page: public/apps/*.jpg,
 * 1920×1200, holding demo data only (each entry below says where its picture comes from, and each
 * alt says what is on screen, so none passes for more than it is). That no two of them look alike
 * is the point, so the pictures are plain: no browser chrome, no frame, only a hairline. Every one
 * ends on a whole element (a card, a window edge, a paragraph) with the same air around it, never
 * mid-line.
 *
 * On a phone a 16:10 picture shrinks to a texture, so there the tile is 4:3 and shows one part of
 * the picture, larger: `crop` below is that part, a window of the picture's own pixels (z is how
 * many times larger than the tile the picture is drawn, x and y the window's top left), turned
 * into custom properties for made.css.
 *
 * The gallery is a native scroll-snap row, full-bleed, so momentum, swiping and the no-JS fallback
 * come from the browser and nothing is ever scrolled by script on its own. One slide is active: the
 * one whose centre is nearest the row's centre. It sits at full strength with its caption; the
 * others wait at .4 with theirs hidden, and a click on one brings it to the centre. Dots and two
 * paddles under the row do the same from the keyboard or a mouse. The dots are one tab stop, the
 * current dot, which Left and Right move along; the focused row takes Left and Right as well. All
 * of that dimming and hiding is scoped to html[data-js] (made.css), so without script, or if the app
 * never hydrates, every slide and caption shows. It never advances by itself. */

const PICTURE = { w: 1920, h: 1200 };

type Crop = { z: number; x: number; y: number };

/** A crop as the three numbers made.css wants: the zoom, and where the window sits in the room the
 * zoom leaves (0 is flush left or top, 1 flush right or bottom, like object-position). The window is
 * 1920/z wide and 4:3, so its height is 1440/z. Rounded to four places so the prerender and the
 * hydrated page write the same style. */
function cropVars({ z, x, y }: Crop): CSSProperties {
  const room = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    "--z": z,
    "--px": room(x / (PICTURE.w - PICTURE.w / z)),
    "--py": room(y / (PICTURE.h - (PICTURE.w * 0.75) / z)),
  } as CSSProperties;
}

const APPS = [
  {
    // the reading step of sankofa's landing, its own words left out: a public-domain letter (New
    // York, 14 May 1863) read line by line beside the app's transcription panel, as the landing
    // redraws it. The folio's whole sheet is in frame, set on the page's own cream, with the scan
    // line's stubs painted out. On a phone: the transcription panel.
    id: "sankofa",
    forWhom: "For friends writing history PhDs at Harvard.",
    what: "Reads, corrects and indexes 19th-century handwritten documents.",
    alt: "sankofa’s reading view, with a public-domain letter from 1863 beside its transcription. Each line’s handwriting sits above its typed text, with the misread words struck through and corrected.",
    light: true,
    crop: { z: 2.6, x: 172, y: 190 },
  },
  {
    // the app itself, signed in to a throwaway copy holding its sample scan (no one's real rooms),
    // in its split view with a piece selected; the page's title and the test account's address
    // are hidden. On a phone: the room in 3D.
    id: "lintel",
    forWhom: "For a move to a new city.",
    what: "Scan an apartment with your phone and furnish it before you arrive. Built in five hours at Vercel’s Fast Forward hackathon.",
    alt: "lintel’s viewer on a sample scan: a studio drawn in 3D with its door, two windows and furniture, a sofa the phone captured in colour, and the same room as a plan. Beside them, the measurements of the table that is selected.",
    light: false,
    crop: { z: 3.15, x: 124, y: 368 },
  },
  {
    // the reader from hermes's landing (its demo pane, lifted out in the app's dark theme), with
    // the read-aloud bar open on a public-domain text under its real author: the first week of
    // Charles Dudley Warner's "My Summer in a Garden" (1870, Project Gutenberg). The bar names the
    // stock voice (Kokoro), the one choice that needs no recording; hermes also lists each voice the
    // user records, so the caption's "a voice they pick" holds either way. The summary shows
    // three of its points and the page ends on its first paragraph, with the air a window has.
    // On a phone: the title and the summary.
    id: "hermes",
    forWhom: "For one reader.",
    what: "Their favourite writers and documents, read aloud in a voice they pick.",
    alt: "hermes reading Charles Dudley Warner’s “My Summer in a Garden”, a public-domain text, with a three-point summary above the text and the read-aloud bar playing in a stock voice.",
    light: false,
    crop: { z: 1.76, x: 400, y: 130 },
  },
  {
    // the itinerary's day card from voyra's landing, drawn by hand from the real editor, over the
    // landing's own map of the trip (its atlas, in the form it takes under reduced motion), the
    // card drawn larger and the atlas's coordinates and scale bar painted out: the first day of the
    // sample trip to Japan, with its flight, its stay and two stops. On a phone: the card.
    id: "voyra",
    forWhom: "For a family trip.",
    what: "One plan for the whole trip, easy to share with everyone coming.",
    alt: "voyra’s first day of a sample trip to Japan: a flight, a hotel and two stops with their times, over a map of Japan that shows the flight arriving at Tokyo.",
    light: false,
    crop: { z: 2.2, x: 976, y: 480 },
  },
  {
    // the Pulse window from anansi's landing, filled in for an invented person (its i18n strings:
    // Nadia, Amara, "Papá cumple 70"), whole and at its native 880 high, stretched to 16:10
    // wide so no card, row or sidebar item is cut. On a phone: the week's two first entries.
    id: "anansi",
    forWhom: "For a person and their therapist.",
    what: "A quiet place to understand yourself.",
    alt: "anansi’s week view, with invented entries: three journal entries written in and, beside them, what is coming up and what is on the horizon.",
    light: true,
    crop: { z: 2.2, x: 340, y: 288 },
  },
] as const;


const LAST = APPS.length - 1;

export function Made() {
  return (
    <Section id="made">
      <Header
        title="The apps no company will make for your family."
        intro={["Software goes where the numbers are, and a family is a market of one.", "Now yours can ask for its own."]}
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
            data-tone={app.light ? "light" : undefined}
            onClick={() => {
              if (i !== current.current) go(i);
            }}
          >
            <div className="made-shot" style={cropVars(app.crop)}>
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
