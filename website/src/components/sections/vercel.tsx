/** Next: from your kitchen to Vercel. One app, Pinch, moves from the box in the kitchen to a data
 * center in one click, and keeps its address and its sign-in; only who can use it and where it runs
 * change. The figure is FIG. 3 (vercel/drawing.tsx), then the one control, then Pinch's card, never
 * overlapping the drawing.
 *
 * The move is not built, so nothing here looks like a button that does it: the control is a page
 * button, "Play the move", with the coming mark in front, and it plays only when pressed. It sits
 * between the drawing and the card, so the arc it plays and the two rows it changes are both in
 * view when it is pressed. The icon rides the route into the rack, the green light follows it, then
 * the two rows that change cross-fade, each washed once; the same button, now "Move it home", plays
 * it back. Vercel's triangle appears only in the drawing and, after the move, in the "Runs on"
 * value. The prerender and reduced motion show the house state; under reduced motion a press swaps
 * instantly, with no flight. Without script the control is hidden (it could do nothing).
 *
 * The section ends on the page's statement, its own block after the note: two sentences, each on
 * its own line(s), so a line never holds the end of one and the start of the other. */

import { type ReactNode, useEffect, useRef, useState } from "react";

import { AppIcon } from "~/components/landing/app-icon";
import { Coming } from "~/components/landing/coming";
import { EASE, motionOn } from "~/components/landing/motion";
import { Header, Section } from "~/components/landing/section";
import { MARKS } from "~/components/marks";
import { type Movers, NarrowDrawing, place, WideDrawing } from "~/components/sections/vercel/drawing";

/** The move's beats, in ms from the press (spec §6.7, less the press itself: a real one shows). */
const AT = { flight: 0, flightFor: 700, light: 700, rows: 780, button: 980, done: 1180 } as const;
/** Moving home plays it backwards in 500: the light first, then the flight. */
const BACK = { flight: 100, flightFor: 400, done: 500 } as const;

const MOVED = "Moved to Vercel. The address and the sign-in stay the same.";
const HOME = "Back home on the box.";

/** Vercel's triangle (marks.tsx), nudged so its base lands on a whole pixel at this size. */
function Triangle({ size }: { size: number }) {
  const k = size / 24;
  const base = 22.392 * k;
  const dy = (Math.round(base) - base) / k;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className="shrink-0">
      <path d={MARKS.vercel} transform={`translate(0 ${dy.toFixed(3)})`} />
    </svg>
  );
}

/** The box, as a 12px glyph: the hero avatar's drawing of it (a case, two vents and its light) on a
 * 12px grid, its 1px lines on half pixels so they stay crisp at 1x. */
function BoxGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <rect x=".5" y="1.5" width="11" height="9" rx="1" stroke="currentColor" />
      <path d="M2.5 3.5H9.5M2.5 5.5H9.5" stroke="currentColor" strokeOpacity=".6" />
      <circle cx="8.75" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

/** A value that changes with the move: the old one fades out, then the new one in. Only the one
 * showing is read out. */
function Swap({ on, from, to }: { on: boolean; from: ReactNode; to: ReactNode }) {
  return (
    <span className="vc-swap">
      <span data-on={on ? undefined : ""} aria-hidden={on || undefined}>
        {from}
      </span>
      <span data-on={on ? "" : undefined} aria-hidden={on ? undefined : true}>
        {to}
      </span>
    </span>
  );
}

export function Vercel() {
  /** Where the lights say Pinch runs (the drawing). */
  const [at, setAt] = useState<"home" | "vercel">("home");
  /** The two rows that change. */
  const [moved, setMoved] = useState(false);
  /** The button offers the way back. */
  const [onVercel, setOnVercel] = useState(false);
  /** Playing it back: shorter fades. */
  const [back, setBack] = useState(false);
  /** Counts forward moves, to key the rows' wash so each move plays it once; 0 is none yet. */
  const [wash, setWash] = useState(0);
  const [said, setSaid] = useState("");

  const wide = useRef<Movers>({ icon: null, trail: null });
  const narrow = useRef<Movers>({ icon: null, trail: null });
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const frame = useRef(0);

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  /** One rAF loop moves the icon and the trail together, from `a` to `b` along the route. */
  const fly = (a: number, b: number, ms: number) => {
    cancelAnimationFrame(frame.current);
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      place(wide.current, narrow.current, a + (b - a) * EASE.inout(p));
      if (p < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  const go = () => {
    busy.current = true;
    setBack(false);
    setSaid("");
    if (!motionOn()) {
      place(wide.current, narrow.current, 1);
      setAt("vercel");
      setMoved(true);
      setOnVercel(true);
      setSaid(MOVED);
      busy.current = false;
      return;
    }
    later(AT.flight, () => fly(0, 1, AT.flightFor));
    later(AT.light, () => setAt("vercel"));
    later(AT.rows, () => {
      setMoved(true);
      setWash((n) => n + 1);
    });
    later(AT.button, () => setOnVercel(true));
    later(AT.done, () => {
      busy.current = false;
      setSaid(MOVED);
    });
  };

  const goHome = () => {
    busy.current = true;
    setBack(true);
    setAt("home");
    setMoved(false);
    setOnVercel(false);
    setSaid(HOME);
    if (!motionOn()) {
      place(wide.current, narrow.current, 0);
      busy.current = false;
      return;
    }
    later(BACK.flight, () => fly(1, 0, BACK.flightFor));
    later(BACK.done, () => {
      busy.current = false;
    });
  };

  const press = () => {
    if (busy.current) return;
    if (onVercel) goHome();
    else go();
  };

  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  return (
    <Section id="vercel">
      <Header
        title="Next: from your kitchen to Vercel, in one click."
        intro={
          <>
            <span className="vc-sentence">Pinch was made for one family.</span>{" "}
            <span className="vc-sentence">Then a cousin asks for it, and her friends do too.</span>
          </>
        }
        prose="The day something you made could help people outside your house, it should move in one click to Vercel, a cloud made for apps that serve millions, keeping its address and its sign-in. Your house keeps building for you, and Vercel serves everyone else."
      />

      <div className="vc-fig after-header" data-at={at} data-back={back ? "" : undefined}>
        <div className="vc-draw">
          <WideDrawing
            icon={(el) => {
              wide.current.icon = el;
            }}
            trail={(el) => {
              wide.current.trail = el;
            }}
          />
          <NarrowDrawing
            icon={(el) => {
              narrow.current.icon = el;
            }}
            trail={(el) => {
              narrow.current.trail = el;
            }}
          />
        </div>

        <div className="wrap">
          <div className="vc-act">
            <button
              type="button"
              className="btn btn-secondary btn-sm vc-play"
              aria-label={onVercel ? "Move it home (a preview)" : "Play the move to Vercel (a preview)"}
              onClick={press}
            >
              <Coming />
              <span className="vc-labels">
                <span data-on={onVercel ? undefined : ""}>Play the move</span>
                <span data-on={onVercel ? "" : undefined}>Move it home</span>
              </span>
            </button>
          </div>

          <div className="fragment lifted vc-card" data-moved={moved ? "" : undefined}>
            <div className="vc-head">
              <AppIcon app="pinch" size={40} />
              <div>
                <p className="vc-name">Pinch</p>
                <p className="vc-sub">The family’s recipes</p>
              </div>
            </div>

            <dl className="vc-rows">
              <div className="vc-row">
                <dt>Address</dt>
                <dd className="vc-mono">pinch.rivera.family</dd>
              </div>
              <div className="vc-row">
                <dt>Sign-in</dt>
                <dd>Face or fingerprint</dd>
              </div>
              <div className="vc-row">
                {wash > 0 && <span key={wash} className="vc-wash" aria-hidden />}
                <dt>Who can use it</dt>
                <dd>
                  <Swap on={moved} from={<span>Your family</span>} to={<span>Any family, each with its own recipes</span>} />
                </dd>
              </div>
              <div className="vc-row">
                {wash > 0 && <span key={wash} className="vc-wash" aria-hidden />}
                <dt>Runs on</dt>
                <dd>
                  <Swap
                    on={moved}
                    from={
                      <>
                        <BoxGlyph />
                        <span>The box, in the kitchen</span>
                      </>
                    }
                    to={
                      <>
                        <Triangle size={12} />
                        <span>Vercel</span>
                      </>
                    }
                  />
                </dd>
              </div>
            </dl>
            <p className="sr-only" aria-live="polite">
              {said}
            </p>
          </div>

          <p className="t-caption vc-note">
            <Coming />
            Not built yet. So far one app has made this move, by hand: lintel, for the hackathon.
          </p>
        </div>
      </div>

      <div className="wrap">
        <p className="t-h2 vc-close">
          <span>There will be billions of deployments a day.</span>
          <span>
            <span className="vc-clause">None of them made by a human,</span>{" "}
            <span className="vc-clause">all of them made for one.</span>
          </span>
        </p>
      </div>
    </Section>
  );
}
