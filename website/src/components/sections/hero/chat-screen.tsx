/** Phone A's screen: your conversation with Home, the box in the kitchen, in iOS dark mode. You ask
 * for an app for Grandma's recipe cards; Home asks two questions, goes quiet, and comes back with
 * Pinch. The bubbles are monochrome on purpose (never iMessage blue: this is not iMessage) and have
 * no tails.
 *
 * Every row is in the layout from the first frame, so nothing moves when a later one appears. The
 * prerender, reduced motion and no-JS show the finished thread, anchored to its last row. With
 * motion the column starts anchored under the header and each row arrives at its `at` (ms from the
 * chat's start, at the hero's tempo), Home's after 600ms of typing dots that sit exactly where the
 * reply will. The hero (hero.tsx) reads the rows' `data-at` and slides the column so each arrival
 * is in view.
 *
 * A bubble hugs its text, as in Messages: each wrapped one is as wide as its longest line, so a short
 * last line never leaves a wide empty strip on the right. A one-line bubble hugs by itself; a
 * wrapped one carries that width as a literal (`w`: its longest line in Geist, rounded up, plus the
 * padding), so the prerender, no-JS and reduced motion draw the hugged bubble and hydration changes
 * nothing. Once the fonts are in, the same measuring runs again for whatever font the page really
 * has: on a Mac, SF Pro sets about 4% wider than Geist, so a literal can be a line too narrow
 * there. A bubble that is taller at its literal than at the 230px ceiling goes back to the ceiling
 * and hugs from there; one whose measured width would not change a line break keeps it. The heights
 * the hero measures are taken after this, so they are always the real ones. Styles:
 * styles/landing/hero.css, `.chat*`. */

import { type CSSProperties, useEffect, useRef } from "react";
import { AppIcon } from "~/components/landing/app-icon";

type Row =
  | { kind: "me" | "home"; text: string; at?: number; w?: number }
  | { kind: "later"; at: number }
  | { kind: "card"; at: number };

/** The thread, in order. The text is the hero's; hero.tsx lists it again for screen readers. */
export const THREAD: readonly Row[] = [
  {
    kind: "me",
    text: "Can you make us an iPhone app for Grandma’s recipe cards? Scan them, keep her handwriting, and let the family add notes.",
    w: 227,
  },
  { kind: "home", text: "Is it just for the family, or for anyone with a link?", at: 1100, w: 230 },
  { kind: "me", text: "Just the family. Grandma too.", at: 1600 },
  { kind: "home", text: "Should I type out each card next to her handwriting, so you can search for “lentils”?", at: 2700, w: 226 },
  { kind: "me", text: "Yes please!", at: 3200 },
  { kind: "home", text: "On it. I’ll tell you when it’s ready.", at: 4300 },
  { kind: "later", at: 4800 },
  {
    kind: "home",
    text: "Pinch is ready. The family’s invites are on their iPhones, Grandma’s too.",
    at: 5900,
    w: 181,
  },
  { kind: "card", at: 6100 },
];

/** Home types for this long before each reply. */
export const TYPING_MS = 600;

/** The four requests the composer runs through once after the sequence (768 and up): the tree's
 * other four apps, each short enough to sit whole in the field's 230px with SF Pro's metrics and
 * room to spare (160px at most in Geist), so none is ever cut off mid-word. */
export const EXAMPLES = [
  "School forms I need to sign",
  "Remind Dad to take his pills",
  "A page for the babysitter",
  "Track how tall the kids get",
] as const;

/** Space above each row: 6 between senders, 2 within a run (the card is Home's), none after the
 * timestamp or "Later", whose own margins hold the space. */
const GAPS = THREAD.map((row, i) => {
  const prev = THREAD[i - 1];
  if (!prev || prev.kind === "later") return 0;
  const from = (r: Row) => (r.kind === "card" ? "home" : r.kind);
  return from(prev) === from(row) ? 2 : 6;
});

const at = (ms: number) => ({ "--at": `${ms}ms` }) as CSSProperties;

/** The box, as Home's avatar: a case with two vents and its status light, the hero's one green. */
function BoxGlyph() {
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden>
      <rect x="1.5" y="1.5" width="13" height="11" rx="1" stroke="#fff" />
      <path d="M3.5 4.5H12.5M3.5 6.5H12.5" stroke="#fff" strokeOpacity=".6" />
      <circle cx="11.5" cy="10" r="1.2" fill="#4ea87a" />
    </svg>
  );
}

/** The composer's placeholder: two spans in one cell, so one can fade out before the other rises
 * in. `step` 0 and 5 are "Message Home"; 1 to 4 are the examples. Even steps live in the first
 * span and odd ones in the second, so the span coming in always changes text while it is hidden. */
function Placeholder({ step }: { step: number }) {
  const text = (s: number) => (s <= 0 || s >= 5 ? "Message Home" : EXAMPLES[s - 1]);
  const even = step % 2 === 0 ? step : step - 1;
  const odd = step % 2 === 1 ? step : step - 1;
  return (
    <span className="chat-field">
      <span className="chat-ph" data-live={step % 2 === 0 ? "" : undefined}>
        {text(even)}
      </span>
      <span className="chat-ph" data-live={step % 2 === 1 ? "" : undefined}>
        {odd >= 1 ? text(odd) : ""}
      </span>
    </span>
  );
}

/** Bubble side padding, both sides (hero.css `.chat-b`). */
const BUBBLE_PAD = 20;

export function ChatScreen({ composerStep = 0 }: { composerStep?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live || !ref.current) return;
      for (const b of Array.from(ref.current.querySelectorAll<HTMLElement>(".chat-b"))) {
        // from the ceiling: this font's own wrap, which the literal in THREAD may not be
        b.style.width = "";
        const range = document.createRange();
        range.selectNodeContents(b);
        const k = b.getBoundingClientRect().width / b.offsetWidth || 1; // the stage's scale
        const lines = Array.from(range.getClientRects(), (r) => r.width / k);
        if (lines.length < 2) continue; // one line hugs by itself
        const tall = b.offsetHeight;
        b.style.width = `${Math.ceil(Math.max(...lines)) + BUBBLE_PAD}px`;
        if (b.offsetHeight !== tall || range.getClientRects().length !== lines.length) b.style.width = "";
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div ref={ref} className="chat">
      <div className="chat-thread">
        <div className="chat-col">
          <p className="chat-stamp">
            <b>Today</b> 8:12 PM
          </p>
          {THREAD.map((row, i) => {
            const gap = GAPS[i] ?? 0;
            if (row.kind === "later") {
              return (
                <p key={i} className="chat-later" data-at={row.at} style={at(row.at)}>
                  Later
                </p>
              );
            }
            if (row.kind === "card") {
              return (
                <div key={i} className="chat-card" data-at={row.at} style={{ ...at(row.at), marginTop: gap }}>
                  <span className="chat-card-icon">
                    <AppIcon app="pinch" size={64} />
                  </span>
                  <span className="chat-card-text">
                    <span className="chat-card-row">
                      <span className="chat-card-name">Pinch</span>
                      <span className="chat-open">Open</span>
                    </span>
                    <span className="chat-card-sub">The family’s recipes</span>
                    <span className="chat-card-url">pinch.riveras.com</span>
                  </span>
                </div>
              );
            }
            const cls = `chat-b chat-${row.kind}${row.at != null ? " chat-arrive" : ""}`;
            if (row.kind === "home" && row.at != null) {
              // the typing dots sit exactly where the reply will land, so the reply replaces them
              return (
                <div key={i} className="chat-slot" data-at={row.at} style={{ marginTop: gap }}>
                  <span className="chat-typing" data-typing-at={row.at - TYPING_MS} style={at(row.at - TYPING_MS)}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <p className={cls} style={{ ...at(row.at), width: row.w }}>
                    {row.text}
                  </p>
                </div>
              );
            }
            return (
              <p
                key={i}
                className={cls}
                data-at={row.at}
                style={row.at != null ? { ...at(row.at), marginTop: gap, width: row.w } : { marginTop: gap, width: row.w }}
              >
                {row.text}
              </p>
            );
          })}
        </div>
      </div>

      <div className="chat-header">
        <svg className="chat-back" width="9" height="15" viewBox="0 0 9 15" fill="none" aria-hidden>
          <path d="M7.5 1.25 1.5 7.5l6 6.25" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="chat-avatar">
          <BoxGlyph />
        </span>
        <span className="chat-name">
          Home
          <svg width="4.5" height="7.5" viewBox="0 0 4.5 7.5" fill="none" aria-hidden>
            <path d="M.75.75 3.75 3.75.75 6.75" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="chat-where">the box in the kitchen</span>
      </div>

      <div className="chat-composer">
        <span className="chat-plus">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </span>
        <Placeholder step={composerStep} />
      </div>
    </div>
  );
}
