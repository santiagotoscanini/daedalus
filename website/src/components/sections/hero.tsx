/** The hero: what daedalus is in two lines, then the whole product in two iPhones. On yours you ask
 * Home, the box in the kitchen, for an app for Grandma's recipe cards; it asks two questions and
 * comes back with Pinch. Then Grandma's phone takes over: TestFlight tells her it is ready, she taps
 * it, Pinch installs, and it opens on her Lentil Soup card, her handwriting above the same recipe
 * typed out. Pinch's coral icon arriving in a grey chat is the first colour in the picture.
 *
 * Where the screen is wide enough for both (1200 and up, and landscape screens from 1024) the hero
 * is one composed first screen, like the page's share image: the words on the left, both phones on
 * the right, scaled so the pair always fits under the nav (hero.css). Elsewhere the words stack over
 * the phones; below 768 the phones share one spot, with a labelled two-part switch above them (and a
 * horizontal swipe on the phone) after the sequence, or a plain swipeable row without script.
 *
 * The sequence plays once, in two acts that each wait until the reader can see them (hero/timeline.ts):
 * your chat once the top of your phone is on screen, Grandma's phone once the top of hers is. Then it
 * holds its final frame, which is also what the prerender, reduced motion and no-JS show (and what
 * the page falls back to if the script never runs: motion only exists under html[data-motion="on"]).
 * Almost all of it is CSS keyframes in styles/landing/hero.css; the script here starts each act,
 * keeps each arrival in the part of your phone that is on screen (even as the reader scrolls),
 * ends the sequence, swaps the phones on narrow screens and runs the composer's examples once. The
 * devices are aria-hidden; a visually hidden list carries the conversation. */

import { type PointerEvent, useEffect, useRef, useState } from "react";
import { Coming } from "~/components/landing/coming";
import { motionOn, round1, useFigure } from "~/components/landing/motion";
import { Section, SectionLink } from "~/components/landing/section";
import { ChatScreen, THREAD } from "./hero/chat-screen";
import { HomeScreen } from "./hero/home-screen";
import { IPhone } from "./hero/iphone";
import { PinchScreen } from "./hero/pinch-screen";
import {
  COMPOSER_AFTER_E,
  COMPOSER_STEP,
  DONE_AFTER_E,
  E_DELAY_NARROW,
  E_DELAY_WIDE,
  EDGE_CLEAR,
  FLOOR_MIN,
  HANDOVER_NARROW,
  HANDOVER_WIDE,
  NARROW,
  TEMPO_NARROW,
  TEMPO_WIDE,
  THREAD_PAD,
  THREAD_TOP,
} from "./hero/timeline";

const REPO = "https://github.com/santiagotoscanini/daedalus";

type Phone = "a" | "b";

/** The thread follow: see `follow` in Hero. */
interface Follow {
  /** [ms from the chat's start, bottom edge in the column] for each arrival and each typing bubble */
  stops: [number, number][];
  /** the column's resting place, where the bottom-anchored final frame has it */
  end: number;
  to: (px: number) => void;
  arrive: (bottom: number) => void;
  /** follows the reader's scrolling until the returned function is called */
  watch: () => () => void;
}

export function Hero() {
  const stageRef = useRef<HTMLDivElement>(null);
  const watchA = useRef<HTMLDivElement>(null);
  const watchB = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Phone>("a");
  const [composerStep, setComposerStep] = useState(0);
  const run = useRef({
    started: false,
    handed: false,
    done: false,
    timers: [] as number[],
    /** undone when the sequence ends: the scroll follow, the wait for Grandma's phone */
    halt: [] as (() => void)[],
    /** undone on unmount: the composer's pass, which outlives the sequence */
    stop: () => {},
    follow: undefined as Follow | null | undefined,
  });

  const root = () => stageRef.current?.closest<HTMLElement>("#top") ?? null;

  /** Thread follow. Every row is laid out from the start (a hidden one keeps its space), so each
   * arrival's bottom edge is known before it arrives. The column slides so the newest row sits at
   * the bottom of the part of the thread the reader can see: the thread's own bottom edge, or the
   * viewport's when it cuts your phone short, and it keeps doing so as the reader scrolls, so the
   * conversation always happens where they are looking. It rests where the bottom-anchored final
   * frame (no motion) rests, and stays top-anchored there afterwards (data-follow), so the end
   * never moves it, not even by the half pixel a re-anchor can round to. */
  const follow = (): Follow | null => {
    const r = run.current;
    if (r.follow !== undefined) return r.follow;
    const col = stageRef.current?.querySelector<HTMLElement>(".hero-slide-a .chat-col");
    const thread = col?.parentElement;
    if (!col || !thread) return (r.follow = null);
    const stops: [number, number][] = [];
    for (const el of Array.from(col.children) as HTMLElement[]) {
      if (el.dataset.at) stops.push([Number(el.dataset.at), el.offsetTop + el.offsetHeight]);
      const dots = el.querySelector<HTMLElement>("[data-typing-at]");
      if (dots?.dataset.typingAt) stops.push([Number(dots.dataset.typingAt), el.offsetTop + dots.offsetHeight]);
    }
    stops.sort((x, y) => x[0] - y[0]);
    const h = thread.clientHeight;
    let now = 0;
    let newest = 0; // the request alone never moves the column
    const to = (px: number) => {
      if (px === now) return;
      now = px;
      col.style.setProperty("--shift", `${px}px`);
    };
    const place = () => {
      const box = thread.getBoundingClientRect();
      const k = box.height / h || 1; // the stage's scale
      const seen = (window.innerHeight - EDGE_CLEAR - box.top) / k;
      const floor = Math.max(FLOOR_MIN, Math.min(h, seen)) - THREAD_PAD;
      return round1(Math.min(0, floor - THREAD_TOP - newest - THREAD_PAD));
    };
    const watch = () => {
      let frame = 0;
      const onMove = () => {
        if (!frame)
          frame = window.requestAnimationFrame(() => {
            frame = 0;
            to(place());
          });
      };
      window.addEventListener("scroll", onMove, { passive: true });
      window.addEventListener("resize", onMove);
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("scroll", onMove);
        window.removeEventListener("resize", onMove);
      };
    };
    // where the bottom-anchored final frame rests, to the hundredth: the column is 16.5px-lined, so
    // its height is rarely whole, and offsetHeight would put the text a fraction of a pixel off it
    const resting = () => {
      const k = thread.getBoundingClientRect().height / h || 1;
      return Math.round((h - THREAD_PAD - THREAD_TOP - col.getBoundingClientRect().height / k) * 100) / 100;
    };
    col.setAttribute("data-follow", "");
    return (r.follow = {
      stops,
      end: resting(),
      to,
      arrive: (bottom) => {
        newest = Math.max(newest, bottom);
        to(place());
      },
      watch,
    });
  };

  /** The final frame, now: at the natural end, or when the reader takes the pager mid-sequence. */
  const finish = () => {
    const r = run.current;
    if (r.done) return;
    r.done = true;
    for (const t of r.timers) window.clearTimeout(t);
    r.timers = [];
    for (const undo of r.halt.splice(0)) undo();
    const top = root();
    top?.setAttribute("data-played", "");
    top?.setAttribute("data-done", "");
    const f = follow();
    f?.to(f.end);
  };

  const at = (ms: number, fn: () => void) => run.current.timers.push(window.setTimeout(fn, ms));

  /** Act one: your chat, from the moment the top of your phone is on screen. */
  const play = () => {
    const r = run.current;
    if (r.started || r.done) return;
    r.started = true;
    root()?.setAttribute("data-played", "");
    const narrow = window.matchMedia(NARROW).matches;
    const tempo = narrow ? TEMPO_NARROW : TEMPO_WIDE;

    const f = follow();
    if (f) {
      for (const [t, bottom] of f.stops) at(Math.round(t * tempo), () => f.arrive(bottom));
      const unwatch = f.watch();
      r.halt.push(unwatch);
    }

    // Act two waits for the top of Grandma's screen (her notification and Pinch's slot) to be
    // whole on screen under the nav; until then your phone rests on its last row.
    at(narrow ? HANDOVER_NARROW : HANDOVER_WIDE, () => {
      const el = watchB.current;
      if (!el) return handover(narrow);
      const nav = document.querySelector<HTMLElement>(".nav-bar")?.offsetHeight ?? 64;
      const io = new IntersectionObserver(
        (entries) => {
          const e = entries[entries.length - 1];
          if (e?.isIntersecting && e.intersectionRatio >= 0.99) {
            io.disconnect();
            handover(narrow);
          }
        },
        { rootMargin: `-${nav}px 0px 0px 0px`, threshold: [0.99, 1] },
      );
      io.observe(el);
      r.halt.push(() => io.disconnect());
    });
  };

  /** Act two: Grandma's phone. Its beats are keyframes timed from data-b (hero.css). */
  const handover = (narrow: boolean) => {
    const r = run.current;
    if (r.handed || r.done) return;
    r.handed = true;
    root()?.setAttribute("data-b", "");
    const E = narrow ? E_DELAY_NARROW : E_DELAY_WIDE;
    if (narrow) setShown("b");
    // the column settles where the final frame has it as her phone comes in beside yours, or, on a
    // phone, once Grandma's has covered it
    const f = follow();
    at(narrow ? 500 : 0, () => {
      for (const undo of r.halt.splice(0)) undo();
      f?.to(f.end);
    });
    at(E + DONE_AFTER_E, finish);
    if (!narrow) composer(E + COMPOSER_AFTER_E);
  };

  /** The composer's single pass through the examples, `after` ms from now. It waits for the composer
   * to be on screen; if the reader scrolls it away mid-pass, it goes back to "Message Home" and
   * stays there. It outlives finish(): the pass starts half a second after the sequence ends. */
  const composer = (after: number) => {
    const field = stageRef.current?.querySelector(".hero-slide-a .chat-composer");
    let step = 0;
    let timer = 0;
    let going = false;
    const tick = () => {
      step += 1;
      setComposerStep(step);
      if (step < 5) timer = window.setTimeout(tick, COMPOSER_STEP);
      else io?.disconnect();
    };
    const io = field
      ? new IntersectionObserver(([e]) => {
          if (!e) return;
          if (e.isIntersecting && !going) {
            going = true;
            tick();
          } else if (!e.isIntersecting && going) {
            window.clearTimeout(timer);
            io?.disconnect();
            if (step < 5) setComposerStep(5);
          }
        })
      : null;
    const begin = window.setTimeout(() => {
      if (io && field) io.observe(field);
      else {
        going = true;
        tick();
      }
    }, after);
    run.current.stop = () => {
      window.clearTimeout(begin);
      window.clearTimeout(timer);
      io?.disconnect();
    };
  };

  useFigure(watchA, { threshold: 1, fonts: true, alwaysArmed: true, onPlay: play });

  useEffect(() => {
    const r = run.current;
    return () => {
      for (const t of r.timers) window.clearTimeout(t);
      for (const undo of r.halt.splice(0)) undo();
      r.stop();
    };
  }, []);

  /** The pager and the swipe: the final frame at once, then the chosen phone. */
  const pick = (p: Phone) => {
    if (motionOn()) finish();
    setShown(p);
  };
  const swipe = useRef<{ id: number; x: number; y: number } | null>(null);
  const onDown = (e: PointerEvent) => {
    if (window.matchMedia(NARROW).matches) swipe.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(e.clientY - s.y)) pick(dx < 0 ? "b" : "a");
  };

  return (
    <Section id="top" className="hero">
      <div className="wrap">
        <div className="hero-copy">
          <h1 id="top-title" className="t-hero">
            <span className="hero-line-1">Your own cloud, at home.</span>
            <span className="block">You just talk to it.</span>
          </h1>
          <p className="t-intro hero-lead">
            daedalus turns a computer in your house into your family’s own cloud. Ask for any app from your phone,
            and you never need to know how it gets made, unless you want to.
          </p>
          <div className="hero-ctas">
            <SectionLink hash="start" className="btn btn-primary">
              Get started
            </SectionLink>
            <SectionLink hash="made" className="btn btn-secondary">
              See the apps
            </SectionLink>
          </div>
          <p className="t-caption hero-free">
            Free and{" "}
            <a href={REPO} className="link">
              open source
            </a>
            .
          </p>
        </div>

        <div className="sr-only">
          <p>A conversation on your iPhone with Home, the box in the kitchen:</p>
          <ol>
            {THREAD.map((row, i) =>
              row.kind === "me" || row.kind === "home" ? (
                <li key={i}>{`${row.kind === "me" ? "You" : "Home"}: ${row.text}`}</li>
              ) : row.kind === "card" ? (
                <li key={i}>Home: Pinch, the family’s recipes, at pinch.riveras.com.</li>
              ) : null,
            )}
          </ol>
          <p>
            On Grandma’s iPhone, Pinch installs from TestFlight and opens on her Lentil Soup card: her handwritten
            card, the same recipe typed out below it, and notes from Dad and Sofi.
          </p>
        </div>

        {/* Below 768 and with script: which phone, in words, above the one spot, so the chat is a named
            choice on the first screen. It sits in the source before the stage; hidden elsewhere. */}
        <div className="hero-pager" role="group" aria-label="Phones" data-shown={shown}>
          {(["a", "b"] as const).map((p) => (
            <button key={p} type="button" className="hero-seg" aria-pressed={shown === p} onClick={() => pick(p)}>
              {p === "a" ? "Your iPhone" : "Grandma’s iPhone"}
            </button>
          ))}
        </div>

        <div className="hero-figure">
          {/* Without script the stage is a row to swipe, which a browser makes a tab stop: it is a
              named group, so that stop lands on something a screen reader can see (the captions);
              the devices themselves are pictures, told by the list above. */}
          <div
            ref={stageRef}
            className="hero-stage"
            data-shown={shown}
            role="group"
            aria-label="Your iPhone and Grandma’s iPhone"
            onPointerDown={onDown}
            onPointerUp={onUp}
            onPointerCancel={() => {
              swipe.current = null;
            }}
          >
            <div className="hero-slide hero-slide-a">
              <div className="hero-dev" aria-hidden>
                <IPhone finish="black">
                  <ChatScreen composerStep={composerStep} />
                </IPhone>
              </div>
              <p className="t-caption hero-cap">Your iPhone</p>
            </div>
            <div className="hero-slide hero-slide-b">
              <div className="hero-dev" aria-hidden>
                <IPhone finish="desert">
                  <HomeScreen />
                  <div className="pinch-open">
                    <PinchScreen />
                  </div>
                </IPhone>
              </div>
              <p className="t-caption hero-cap">Grandma’s iPhone</p>
            </div>
            {/* what each act waits for: the top of your screen, then the top of Grandma's */}
            <div ref={watchA} className="hero-watch hero-watch-a" />
            <div ref={watchB} className="hero-watch hero-watch-b" />
            {/* where her phone will stand, until it arrives (768 and up) */}
            <div className="hero-ghost" aria-hidden />
          </div>
        </div>

        {/* one sentence a line wherever it takes two (hero.css); where the first wraps it breaks at the comma */}
        <p className="t-caption hero-next">
          <span className="hero-next-1">
            <Coming />
            Today you ask through Claude Code on the box,{" "}
            <span className="hero-keep">from the Claude app on your phone.</span>
          </span>{" "}
          <span className="hero-next-2">Talking to the house itself, like this, is next.</span>
        </p>
      </div>
    </Section>
  );
}
