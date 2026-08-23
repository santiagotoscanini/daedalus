import { useEffect, useState } from "react";
import { BrandMark } from "~/components/brand-marks";

/** The hero's cycling headline: "Your own <vendor>", typed and erased.
 *
 * The vendors are the same ones the ledger in `rented-cloud.tsx` itemizes,
 * so the hero's claim and the receipt below it name the same services.
 *
 * Three things this has to get right:
 *
 *  - **The prerender.** The site is built to static HTML, so the document
 *    must carry a real word rather than an empty line. First paint is
 *    vendor 0 fully typed; the animation only starts once an effect has
 *    run, which is also where reduced-motion opts out entirely.
 *  - **The accessible name.** A heading that rewrites itself character by
 *    character is announced as churn by a screen reader. The visible line
 *    is `aria-hidden` and the h1 carries one static sentence instead, so
 *    the heading reads once and says everything.
 *  - **The mark swap.** The logo only changes while the word is empty, so
 *    the two never disagree mid-keystroke. */

/* Kept short on purpose. The heading's first line is "Your own <vendor>" at
 * 4.5rem, and a long name ("Google Cloud") wraps it onto a third line —
 * which moves every element below the hero, on a loop, forever. GCP fits. */
const VENDORS = ["Vercel", "AWS", "GCP", "Heroku", "Auth0", "Datadog"];

const TYPE_MS = 55;
const ERASE_MS = 28;
const HOLD_FULL_MS = 1700;
const HOLD_EMPTY_MS = 320;

export function VendorCycle() {
  const [index, setIndex] = useState(0);
  const [len, setLen] = useState(VENDORS[0]?.length ?? 0);
  const [erasing, setErasing] = useState(false);
  const [running, setRunning] = useState(false);

  // Gate on the client: SSR keeps the fully-typed first vendor, and a
  // reduced-motion reader keeps it forever.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setRunning(true);
  }, []);

  // Idle in a background tab. Timers there would burn a phone's battery
  // animating a heading nobody is looking at.
  useEffect(() => {
    if (!running) return;
    const onVisibility = () => setRunning(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [running]);

  useEffect(() => {
    if (!running || document.hidden) return;
    const word = VENDORS[index] ?? "";
    const atEnd = len >= word.length;
    const atStart = len <= 0;

    const delay = erasing
      ? atStart
        ? HOLD_EMPTY_MS
        : ERASE_MS
      : atEnd
        ? HOLD_FULL_MS
        : TYPE_MS;

    const id = window.setTimeout(() => {
      if (erasing) {
        if (atStart) {
          setIndex((i) => (i + 1) % VENDORS.length);
          setErasing(false);
        } else {
          setLen((n) => n - 1);
        }
      } else if (atEnd) {
        setErasing(true);
      } else {
        setLen((n) => n + 1);
      }
    }, delay);

    return () => window.clearTimeout(id);
  }, [running, index, len, erasing]);

  const word = VENDORS[index] ?? "";
  const shown = word.slice(0, len);

  return (
    <span className="inline-flex items-center gap-[0.28em] whitespace-nowrap">
      {/* Mark and word share one flat ember (see .text-ember-word), so the
          two read as a single object rather than a logo beside a word. */}
      <BrandMark
        name={word}
        className="text-ember-word h-[0.72em] w-[0.72em] shrink-0 transition-opacity duration-150"
        style={{ opacity: len === 0 ? 0 : 1 }}
      />
      <span className="text-ember-word">{shown}</span>
      <span aria-hidden className="type-caret" />
    </span>
  );
}

/** The one sentence a screen reader gets in place of the animation. */
export const VENDOR_CYCLE_LABEL = `Your own ${VENDORS.slice(0, -1).join(", ")} or ${
  VENDORS[VENDORS.length - 1]
}. On one box.`;
