/** "It lives on the kitchen counter.": where the answers run. One drawing of a house in cutaway with
 * the box on the kitchen counter, on the page axis, and a run to it from every other machine in the
 * house; its internet cable is broken and its light still on. One caption slot under the drawing
 * says what the break means ("The internet is out. The box and the family's apps are still on."),
 * and pointing at a machine (or focusing or tapping it) swaps it for what that machine lends the
 * house. Below 880px of column the drawing crops to the kitchen, with the same caption, and the
 * machines become a plain list. One paragraph follows the figure: what owning the box means, and
 * what the other machines lend it; beside the list, which has just said the second part machine by
 * machine, only the first.
 *
 * Motion (once, when half the figure is in view): the runs draw in, machine by machine, onto the
 * collector above the box; the cable breaks; "still on" appears, and then the caption turns from
 * the box to the outage. The light never changes. Reduced motion, no script and the prerender all
 * show that final frame. */

import {
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Coming, ComingLine } from "~/components/landing/coming";
import { useFigure } from "~/components/landing/motion";
import { Header, Prose, Section } from "~/components/landing/section";
import { Mark } from "~/components/marks";
import { KitchenDrawing } from "./kitchen/drawing";
import { LIST_ORDER, MACHINES, type MachineId, OUTAGE, type Os } from "./kitchen/machines";

/** A machine's mark in running text, drawn on its own pixel grid at the size it is used (14 in the
 * readout, 16 in the list). The apple and the penguin are the brand marks (marks.tsx; the penguin is
 * the filled one Start draws too, even-odd so its belly stays cut out). The Windows mark is its four
 * squares set on half pixels (crisp at 2x) and drawn smaller than the box it sits in: a solid square
 * carries far more ink than the apple's or the penguin's silhouette, so at the same size it read as
 * the heaviest mark in the list. The box has no brand, so it is the hero's drawing of it (a case, two
 * vents and its light), 16 wide and 14 tall; in the list it is centred in the row's 16px square. */
function OsMark({ os, size }: { os: Os; size: 14 | 16 }) {
  if (os === "apple") return <Mark id="apple" size={size} className="k-os" />;
  if (os === "linux") return <Mark id="linux" size={size} className="k-os" />;
  if (os === "box") {
    return (
      <svg
        width="16"
        height={size}
        viewBox={size === 16 ? "0 -1 16 16" : "0 0 16 14"}
        fill="none"
        className="k-os"
        aria-hidden
      >
        <rect x="1.5" y="1.5" width="13" height="11" rx="1" stroke="currentColor" />
        <path d="M3.5 4.5H12.5M3.5 6.5H12.5" stroke="currentColor" strokeOpacity=".6" />
        <circle cx="11.5" cy="10" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="k-os" aria-hidden>
      <path
        fill="currentColor"
        d={
          size === 14
            ? "M2 2h4.5v4.5H2zM7.5 2H12v4.5H7.5zM2 7.5h4.5V12H2zM7.5 7.5H12V12H7.5z"
            : "M2 2h5.5v5.5H2zM8.5 2H14v5.5H8.5zM2 8.5h5.5V14H2zM8.5 8.5H14V14H8.5z"
        }
      />
    </svg>
  );
}

/** Sections above can end on a fraction of a pixel, which would put every hairline of the drawing
 * across two device pixels. This pads the figure by the missing fraction (under 1px, after paint, so
 * the prerender is unchanged), which also puts every section after this one back on whole pixels. */
function useWholePixelTop(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let pad = 0;
    const snap = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const frac = top - Math.floor(top);
      const next = frac < 0.01 || frac > 0.99 ? 0 : Math.round((1 - frac) * 100) / 100;
      if (next === pad) return;
      pad = next;
      el.style.paddingTop = pad ? `${pad}px` : "";
    };
    snap();
    const ro = new ResizeObserver(snap);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [ref]);
}

/** When the caption turns from the box to the outage: as "still on" has finished fading in (it
 * starts at 1600ms and takes 300). */
const OUTAGE_AT = 1900;

export function Kitchen() {
  const fig = useRef<HTMLElement>(null);
  // Once the sequence is over (the last fade ends at 1900ms), the figure is disarmed: the keyframes
  // stop applying and the drawing rests on the same final frame. Otherwise switching between the
  // wide and the narrow drawing (an iPad turned) would replay it, because an element shown again
  // after display:none restarts its animations.
  const timers = useRef<number[]>([]);
  const [outage, setOutage] = useState(false);
  const { armed } = useFigure(fig, {
    threshold: 0.5,
    onPlay: () => {
      timers.current = [
        window.setTimeout(() => setOutage(true), OUTAGE_AT),
        window.setTimeout(() => fig.current?.removeAttribute("data-armed"), OUTAGE_AT + 200),
      ];
    },
  });
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  useWholePixelTop(fig);

  // A pointer shows a machine while it is over it; leaving restores the box. Focus shows one only
  // when it came from the keyboard or a tap, so a mouse click does not pin it after the pointer leaves.
  const [hovered, setHovered] = useState<MachineId | null>(null);
  const [focused, setFocused] = useState<MachineId | null>(null);
  const pointer = useRef("mouse");
  const active = hovered ?? focused;
  // The caption slot rests on the outage. In the one case where the cable has not broken yet (the
  // figure is armed and has not played) it rests on the box instead; the prerender, no script and
  // reduced motion are never armed, so they open on the outage, which is their final frame.
  const shown = active ?? (armed && !outage ? "box" : "outage");

  const bind = useCallback(
    (id: MachineId) => ({
      onPointerEnter: (e: PointerEvent<SVGGElement>) => {
        if (e.pointerType === "mouse") setHovered(id);
      },
      onPointerLeave: (e: PointerEvent<SVGGElement>) => {
        if (e.pointerType === "mouse") setHovered((h) => (h === id ? null : h));
      },
      onPointerDown: (e: PointerEvent<SVGGElement>) => {
        pointer.current = e.pointerType;
        // a tap pins it; Safari does not always move focus to an SVG element on its own
        if (e.pointerType !== "mouse") setFocused(id);
      },
      onFocus: (e: FocusEvent<SVGGElement>) => {
        if (pointer.current !== "mouse" || e.currentTarget.matches(":focus-visible")) setFocused(id);
        pointer.current = "mouse";
      },
      onBlur: () => setFocused((f) => (f === id ? null : f)),
      onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setFocused(id);
        }
      },
    }),
    [],
  );

  // a tap anywhere but on a machine lets the pinned one go (touch browsers do not always blur)
  useEffect(() => {
    if (!focused) return;
    const away = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(".k-mach")) return;
      setFocused(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [focused]);

  return (
    <Section id="kitchen">
      <Header
        title="It lives on the kitchen counter."
        // the microwave is held together, so on two lines the intro breaks at the comma
        intro="daedalus runs on a quiet little box beside the microwave, for about $1 to $3.50 a month in electricity."
      />
      <div className="wrap">
        <figure ref={fig} className="k-fig after-header">
          <div className="k-plate">
            <KitchenDrawing active={active} bind={bind} />
          </div>
          <div className="k-wide">
            {/* each machine's button already carries these words, so the readout is for the eye */}
            <div className="k-readout" aria-hidden="true">
              <p className="k-read" data-on={shown === "outage" || undefined}>
                <OsMark os={OUTAGE.os} size={14} />
                <span>
                  <span className="k-read-lead">{OUTAGE.lead}</span> {OUTAGE.role}
                </span>
              </p>
              {LIST_ORDER.map((id) => {
                const m = MACHINES[id];
                return (
                  <p key={id} className="k-read" data-on={shown === id || undefined}>
                    <OsMark os={m.os} size={14} />
                    <span>
                      <span className="k-read-lead">{m.lead}</span> {m.role}
                    </span>
                    {m.next && (
                      <span className="k-read-next">
                        <Coming />
                        {m.next}
                      </span>
                    )}
                  </p>
                );
              })}
            </div>
          </div>

          <div className="k-narrow">
            {/* the drawing's own words say "still on" and "internet"; this says what they mean */}
            <p
              className="k-outage m-fade"
              style={{ ["--at" as string]: `${OUTAGE_AT - 200}ms`, ["--for" as string]: "300ms" }}
            >
              <span className="k-read-lead">{OUTAGE.lead}</span> {OUTAGE.role}
            </p>
            <ul className="k-list">
              {LIST_ORDER.map((id) => {
                const m = MACHINES[id];
                return (
                  <li key={id} className="k-row">
                    <OsMark os={m.os} size={16} />
                    <div>
                      <p className="k-row-name">{m.lead}</p>
                      <p className="k-row-role">{m.role}</p>
                      {m.next && <ComingLine className="k-row-next">{m.next}</ComingLine>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </figure>
      </div>
      {/* the second half is the list's again, so where the list shows it is left out (kitchen.css) */}
      <Prose className="k-prose">
        {/* one child, so Prose keeps it one paragraph */}
        <>
          It’s yours. Your apps and everything in them live on a disk in your own house, so nobody else decides who gets
          to look at them, and they keep working when the internet doesn’t.
          <span className="k-more">
            {" "}
            The other computers in the house join it with a small app, and each lends what it’s good at: a gaming PC’s
            graphics card runs AI models the whole family can ask, and those questions never leave the house.
          </span>
        </>
      </Prose>
    </Section>
  );
}
