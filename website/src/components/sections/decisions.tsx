/** The tree (#decisions): why talking about Grandma's cards was enough. Every app has to answer the
 * same nine questions, which is 46,656 ways to build it; daedalus answers seven of them the same way
 * every time, and the last two come from what you asked for. The figure is the manifesto's FIG. 1
 * argued for a family: the reader picks a request, watches the house cut the tree, and sees the one
 * path left run from the request to the app.
 *
 * The drawing has two compositions (plate.tsx wide, plate-narrow.tsx on end for phones), both in the
 * DOM, one shown by a container query. This file owns the run: one rAF loop paints whichever state
 * the timeline says, into both, through a writer that skips unchanged values. It plays once, when
 * most of the plate has been in view for a beat (motion.ts); after that, Replay and the selector
 * rerun parts of it. Reduced motion, no-JS and the prerender all show the finished frame. */

import { type KeyboardEvent, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppIcon } from "~/components/landing/app-icon";
import { motionOn, useFigure } from "~/components/landing/motion";
import { Header, Section } from "~/components/landing/section";

import {
  type HotHow,
  type State,
  PlateWide,
  Quote,
  REPLAY_END,
  RUN_END,
  SWITCH_END,
  collect,
  collectWords,
  done,
  paintWide,
  paintWords,
  run,
  sketch,
  swap,
  undo,
  writer,
} from "./decisions/plate";
import { PlateNarrow, paintNarrow } from "./decisions/plate-narrow";
import { COLUMNS, REQUESTS, WHERE, WHO, fmt } from "./decisions/requests";

type Controller = {
  play: () => void;
  select: (r: number) => void;
  replay: () => void;
  /** Show the finished frame now (a row took focus before its answer arrived). */
  settle: () => void;
  dispose: () => void;
};

/** One loop for the plate: whatever runs (the first run, Replay, another request) is a function of
 * elapsed time, painted into both compositions until it ends. If the plate leaves the screen
 * mid-run, it stops at the finished frame. */
function controller(root: HTMLElement, armed: boolean): Controller {
  const put = writer();
  const wideEl = root.querySelector<HTMLElement>('[data-comp="w"]')!;
  const narrowEl = root.querySelector<HTMLElement>('[data-comp="n"]')!;
  const wide = collect(wideEl);
  const narrow = collect(narrowEl);
  const words = collectWords(root);
  // A run paints only the composition on screen (decided once, when it starts); a still frame paints
  // both, so a resize afterwards shows the right one.
  let only: "w" | "n" | null = null;
  const draw = (S: State) => {
    if (only !== "n") paintWide(wide, S, put);
    if (only !== "w") paintNarrow(narrow, S, put);
    paintWords(words, S, put);
  };

  let cur = 0;
  let started = !armed;
  let raf = 0;
  let live: { at: (ms: number) => State; len: number } | null = null;

  // while a run is live the drawing is mid-change, so no row has anything to tell (decisions.css)
  const finish = () => {
    cancelAnimationFrame(raf);
    live = null;
    only = null;
    put(root, "data-live", null);
    draw(done(cur));
  };
  const start = (at: (ms: number) => State, len: number) => {
    cancelAnimationFrame(raf);
    live = { at, len };
    put(root, "data-live", "");
    only = wideEl.offsetParent ? "w" : narrowEl.offsetParent ? "n" : null;
    let t0 = -1;
    const step = (now: number) => {
      if (!live) return;
      if (t0 < 0) t0 = now;
      const ms = now - t0;
      if (ms >= live.len) return finish();
      draw(live.at(ms));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  const io = new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    if (e && !e.isIntersecting && live) finish();
  });
  io.observe(root);

  if (armed) draw(sketch(cur));
  // on screen at load: the finished frame stays, and Replay is offered
  else if (motionOn()) draw(done(cur));

  return {
    play() {
      if (started) return;
      started = true;
      start((ms) => run(ms, cur), RUN_END);
    },
    select(r) {
      if (r === cur) return;
      if (!motionOn()) {
        // reduced motion: the new frame at once, and still no Replay (there is nothing to replay)
        cur = r;
        return draw({ ...done(r), replay: 0 });
      }
      if (!started) {
        // chosen before the plate played: play it now, for this request
        cur = r;
        started = true;
        return start((ms) => run(ms, r), RUN_END);
      }
      if (live) finish();
      const a = cur;
      cur = r;
      start((ms) => swap(ms, a, r), SWITCH_END);
    },
    replay() {
      if (live) finish();
      start((ms) => undo(ms, cur), REPLAY_END);
    },
    settle() {
      if (live || !started) {
        started = true;
        finish();
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      live = null;
      put(root, "data-live", null);
      io.disconnect();
    },
  };
}

/** The sections above can end on a fraction of a pixel, which would put every hairline of the plate
 * across two device pixels. This adds the missing fraction (under 1px) to the plate's top margin after
 * paint, so the prerender is unchanged, and everything below the plate lands on whole pixels again.
 * The margin goes on the plate itself because its request is placed from the plate's edge. */
function useWholePixelTop(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let pad = 0;
    const snap = () => {
      // where the plate would sit without the pad: the pad moves it, so take it back out
      const top = el.getBoundingClientRect().top + window.scrollY - pad;
      const frac = top - Math.floor(top);
      const next = frac < 0.01 || frac > 0.99 ? 0 : Math.round((1 - frac) * 100) / 100;
      if (next === pad) return;
      pad = next;
      el.style.setProperty("--snap", `${pad}px`);
    };
    snap();
    const ro = new ResizeObserver(snap);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [ref]);
}

/** Every number the section prints, computed from the drawing: 46,656, and the 9 the house leaves. */
const TOTAL = COLUMNS.reduce((p, c) => p * c.n, 1);
const LEFT = COLUMNS.slice(7).reduce((p, c) => p * c.n, 1);
const ARITHMETIC = `${COLUMNS.map((c) => c.n).join(" × ")} = ${fmt(TOTAL)}`;

export function Decisions() {
  const [req, setReq] = useState(0);
  const [hot, setHot] = useState<number | null>(null);
  const plate = useRef<HTMLDivElement>(null);
  const ctl = useRef<Controller | null>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const strip = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);

  useFigure(plate, {
    // read once, when the hook arms the plate, so the plate is laid out by then. Wide, .75: the plate
    // enters top first and its axis sits two thirds of the way down, so at .6 the walk ran below the
    // fold. Narrow, .45: the plate runs down the screen, and three quarters of it is in view only
    // while a reader holds still, so at an ordinary scroll it would never play
    get threshold() {
      const fig = plate.current?.parentElement;
      return fig && fig.clientWidth < 920 ? 0.45 : 0.75;
    },
    dwellMs: 300,
    onPlay: () => ctl.current?.play(),
  });
  useWholePixelTop(plate);

  // Declared after useFigure, so its layout effect has already armed the plate or not: an armed
  // plate is reduced to its sketch before the browser paints it.
  useLayoutEffect(() => {
    const root = plate.current;
    if (!root) return;
    const c = controller(root, root.hasAttribute("data-armed"));
    ctl.current = c;
    // each composition's seven answers become one tab stop (plate.tsx, rove), now that a row can tell
    // what runs it
    root.querySelectorAll('[role="list"]').forEach((list) =>
      list.querySelectorAll<HTMLElement>("[data-focus]").forEach((row, i) => (row.tabIndex = i === 0 ? 0 : -1)),
    );
    return () => c.dispose();
  }, []);

  const choose = (r: number, focus = false) => {
    setReq(r);
    ctl.current?.select(r);
    const el = items.current[r];
    if (!el) return;
    if (focus) el.focus({ preventScroll: true });
    // on a phone the row of requests scrolls: bring the chosen one clear of the edge fades
    const s = strip.current;
    if (s && s.scrollWidth > s.clientWidth) {
      const pad = 40;
      const l = el.getBoundingClientRect().left - s.getBoundingClientRect().left + s.scrollLeft;
      const behavior = motionOn() ? "smooth" : "auto";
      if (l - pad < s.scrollLeft) s.scrollTo({ left: l - pad, behavior });
      else if (l + el.offsetWidth + pad > s.scrollLeft + s.clientWidth)
        s.scrollTo({ left: l + el.offsetWidth + pad - s.clientWidth, behavior });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const n = REQUESTS.length;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (req + 1) % n
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (req + n - 1) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(to, true);
  };

  const onHot = useCallback((k: number, how: HotHow) => {
    if (how === "down") pointer.current = true;
    else if (how === "enter") setHot(k);
    else if (how === "leave") setHot((h) => (h === k ? null : h));
    else if (how === "tap") {
      pointer.current = false;
      setHot((h) => (h === k ? null : k));
    } else if (how === "focus") {
      ctl.current?.settle();
      // a tap focuses the row as well: the tap decides, not the focus
      if (!pointer.current) setHot(k);
    } else {
      pointer.current = false;
      setHot((h) => (h === k ? null : h));
    }
  }, []);
  const onReplay = useCallback(() => ctl.current?.replay(), []);

  // On a phone the requests scroll sideways: an edge fades only where there is more to scroll to.
  useEffect(() => {
    const s = strip.current;
    if (!s) return;
    const edges = () => {
      s.toggleAttribute("data-more-l", s.scrollLeft > 1);
      s.toggleAttribute("data-at-end", s.scrollLeft + s.clientWidth >= s.scrollWidth - 1);
    };
    edges();
    s.addEventListener("scroll", edges, { passive: true });
    const ro = new ResizeObserver(edges);
    ro.observe(s);
    return () => {
      s.removeEventListener("scroll", edges);
      ro.disconnect();
    };
  }, []);

  // The row being read brightens its question and its own leader (the elbows belong to the writer's SVG),
  // and shows what runs it (each composition prints it in its own place).
  useEffect(() => {
    const root = plate.current;
    if (!root || hot === null) return;
    const lines = root.querySelectorAll(
      `[data-elbow="${hot}"], [data-lead="${hot}"], [data-focus="${hot}"], [data-under="${hot}"]`,
    );
    lines.forEach((el) => el.setAttribute("data-hot", ""));
    return () => lines.forEach((el) => el.removeAttribute("data-hot"));
  }, [hot]);

  const r = REQUESTS[req]!;
  return (
    <Section id="decisions">
      <Header
        title={"All you talked about was Grandma’s cards."}
        intro="Every hard decision was made before you asked."
        prose={
          "Pinch needed a sign-in for Grandma, a place to keep the recipes, an AI that can read handwriting and a way back if something broke. An engineer can spend weeks on each. daedalus answered them once, for every app, so all that’s left is what you want."
        }
      />
      <div className="wrap after-header">
        <figure className="dc-fig" aria-describedby="decisions-desc">
          <p id="decisions-try" className="dc-label">
            Every app starts from the same seven answers. Try another request:
          </p>
          <div ref={strip} className="dc-strip">
            <div role="radiogroup" aria-label="Example requests" className="dc-sel">
              {REQUESTS.map((x, i) => (
                <button
                  key={x.app}
                  ref={(el) => {
                    items.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={i === req}
                  tabIndex={i === req ? 0 : -1}
                  className="dc-sel-item"
                  onClick={() => choose(i)}
                  onKeyDown={onKey}
                >
                  <AppIcon app={x.app} size={20} />
                  {x.name}
                </button>
              ))}
            </div>
          </div>
          <div ref={plate} className="dc-plate">
            <div className="dc-quotes" aria-hidden>
              {REQUESTS.map((x, i) => (
                <Quote key={x.app} r={i} />
              ))}
            </div>
            <PlateWide onHot={onHot} onReplay={onReplay} />
            <PlateNarrow onHot={onHot} onReplay={onReplay} />
            <p className="sr-only" aria-live="polite">
              {hot !== null ? `Under the hood: ${COLUMNS[hot]!.under}` : ""}
            </p>
          </div>
          <figcaption className="dc-caption">
            <p>
              In this drawing there are {fmt(TOTAL)} ways to build an app. daedalus answers seven of the questions the same
              way every time, and your request answers the last two.
            </p>
          </figcaption>
          <div id="decisions-desc" className="sr-only">
            <p>
              The request: {"“"}
              {r.text}
              {"”"}
            </p>
            <p>
              {ARITHMETIC} ways to build it. The house{"’"}s seven answers leave {COLUMNS.slice(7).map((c) => c.n).join(" × ")} = {LEFT}. From the request, where
              you want it: {WHERE[r.keep[0]]}; who it{"’"}s for: {WHO[r.keep[1]]}. That leaves one way: {r.end}.
            </p>
            <p>How many options each question has is our estimate; every number is computed from the drawing.</p>
          </div>
        </figure>
      </div>
    </Section>
  );
}
