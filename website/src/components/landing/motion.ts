/** The landing's one motion contract: every figure plays once, when it is meaningfully in view, and
 * then holds still. The prerender, no-JS and reduced motion all paint each figure's final frame,
 * because nothing is ever hidden except under `html[data-motion="on"]`, which the head script in
 * __root.tsx sets (and takes away again if the app has not hydrated in 6s).
 *
 * `useFigure` puts two attributes on a figure's root, and the figure's CSS reads them:
 *   start states  html[data-motion="on"] [data-armed]:not([data-played]) …
 *   keyframes     html[data-motion="on"] [data-armed][data-played] …   (with --at, --for, fill both)
 * A figure that is on screen when the page hydrates gets data-played alone: it is already showing
 * its final frame, and playing it there would be an autoplay of something the reader has seen.
 *
 * Also here: the page's curves as JS functions for the rAF writers (tree lattice, Vercel flight,
 * hero thread follow), so a drawn path and a CSS transition beside it ease identically. */

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

declare global {
  interface Window {
    /** Set by the root once React has hydrated; the head script's 6s failsafe reads it. */
    __hydrated?: boolean;
  }
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Is motion on for this reader? Read it in effects and handlers only, never during render (the
 * server cannot know, and a render that differs from the prerender is a hydration mismatch). */
export function motionOn(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-motion");
}

export interface FigureOptions {
  /** How much of the figure must be on screen: a fraction of its height, or of the viewport's
   * when the figure is taller than the viewport. */
  threshold?: number;
  /** How long it must stay that visible before it plays. */
  dwellMs?: number;
  /** Also wait for the web fonts (anything that measures text). */
  fonts?: boolean;
  /** Arm even when on screen at hydration (the hero: it plays on load). */
  alwaysArmed?: boolean;
  /** Called once, when it plays; never for a final frame shown without playing. */
  onPlay?: () => void;
}

// 21 steps, so a figure taller than its threshold allows still reports as it scrolls
const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/** Arms `ref`'s element and plays it once. Options are read once, at mount.
 *
 *  1. Motion off (reduced motion, or the failsafe fired): data-played at once, final frame.
 *  2. On screen at hydration and not alwaysArmed: data-played at once, final frame.
 *  3. Otherwise data-armed (start state, painted before the browser's first frame of it), then
 *     data-played and onPlay once threshold has held for dwellMs (and the fonts are in). */
export function useFigure(
  ref: RefObject<Element | null>,
  options: FigureOptions = {},
): { played: boolean; armed: boolean } {
  const [state, setState] = useState({ played: false, armed: false });
  const onPlay = useRef(options.onPlay);
  useEffect(() => {
    onPlay.current = options.onPlay;
  });

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { threshold = 0.5, dwellMs = 0, fonts = false, alwaysArmed = false } = options;

    const still = () => {
      el.setAttribute("data-played", "");
      setState({ played: true, armed: false });
    };
    if (!motionOn()) return still();
    if (!alwaysArmed) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return still();
    }

    el.setAttribute("data-armed", "");
    setState({ played: false, armed: true });

    let done = false;
    let visible = false;
    let fontsIn = !fonts;
    let timer = 0;
    const play = () => {
      if (done) return;
      done = true;
      io.disconnect();
      el.setAttribute("data-played", "");
      setState({ played: true, armed: true });
      onPlay.current?.();
    };
    const check = () => {
      window.clearTimeout(timer);
      if (done || !visible || !fontsIn) return;
      if (dwellMs > 0) timer = window.setTimeout(play, dwellMs);
      else play();
    };
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[entries.length - 1];
        if (!e) return;
        const span = Math.min(e.boundingClientRect.height, e.rootBounds?.height ?? window.innerHeight);
        const seen = e.isIntersecting && span > 0 && e.intersectionRect.height / span >= threshold - 0.001;
        // re-check only on a change, so callbacks while it stays visible never restart the dwell
        if (seen !== visible) {
          visible = seen;
          check();
        }
      },
      { threshold: STEPS },
    );
    io.observe(el);
    if (fonts) {
      void document.fonts.ready.then(() => {
        fontsIn = true;
        check();
      });
    }
    return () => {
      done = true;
      io.disconnect();
      window.clearTimeout(timer);
    };
    // options are read once, at mount
  }, []);

  return state;
}

/** A CSS cubic-bezier as a function of time (0..1 -> 0..1), for rAF writers. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton first; bisection when the slope is too flat to trust
    let s = t;
    for (let i = 0; i < 8; i++) {
      const err = x(s) - t;
      if (Math.abs(err) < 1e-6) return ((ay * s + by) * s + cy) * s;
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = t;
    for (let i = 0; i < 30; i++) {
      const v = x(s);
      if (Math.abs(v - t) < 1e-6) break;
      if (v < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return ((ay * s + by) * s + cy) * s;
  };
}

/** The page's curves (styles.css @theme), for the rAF writers. */
export const EASE = {
  ui: bezier(0.25, 0.46, 0.45, 0.94),
  out: bezier(0.16, 1, 0.3, 1),
  ios: bezier(0.32, 0.72, 0, 1),
  inout: bezier(0.65, 0, 0.35, 1),
  fill: bezier(0.4, 0, 0.2, 1),
} as const;

/** Geometry written by a rAF writer is rounded to 0.1, so an unchanged value is skipped exactly. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
