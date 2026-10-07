import { useEffect, useState } from "react";

/** The hero's rolling headline: the services the engine stands in for,
 * sliding up one at a time.
 *
 * Only what the engine itself provides is listed: push-to-deploy, the
 * identity provider, monitoring and logs, the registry, the database. The
 * apps a box happens to run (a media server, a photo library) are not the
 * engine, so they are not here. Names only, never their logos.
 *
 * Three things this has to get right:
 *
 *  - **The prerender.** The site builds to static HTML, so the document
 *    carries vendor 0 already in place. Motion only starts once an effect
 *    has run, which is also where reduced-motion opts out for good.
 *  - **The accessible name.** A heading that rewrites itself is announced
 *    as churn. The roll is aria-hidden and the h1 carries one static
 *    sentence naming every vendor, so it reads once and says everything.
 *  - **The line never reflows.** The roll is its own centered block, so a
 *    long name changes nothing above or below it. */

const VENDORS = ["Vercel", "Heroku", "Auth0", "Datadog", "Docker Hub", "Supabase"];

const HOLD_MS = 1900;

/** The track carries one extra copy of the first vendor at the end, so the
 * last step slides FORWARD onto it instead of rewinding the whole column.
 * Once it lands, the offset jumps back to the real first item with the
 * transition off: identical pixels, so the cut cannot be seen. */
const CLONE_INDEX = VENDORS.length;

export function VendorRoll() {
  const [index, setIndex] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setRunning(true);
  }, []);

  // Idle in a background tab rather than animating a heading nobody is
  // looking at.
  useEffect(() => {
    if (!running) return;
    const onVisibility = () => setRunning(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [running]);

  // Every vendor dwells for exactly HOLD_MS, the clone included.
  useEffect(() => {
    if (!running || document.hidden || snapping) return;
    const id = window.setTimeout(() => {
      if (index === CLONE_INDEX) setSnapping(true);
      else setIndex((i) => i + 1);
    }, HOLD_MS);
    return () => window.clearTimeout(id);
  }, [running, index, snapping]);

  // The snap itself. Land on the real first item with no transition, then
  // restore it and move on. Two frames, because a transition re-enabled in
  // the same frame as the offset change would animate the jump we are
  // trying to hide.
  useEffect(() => {
    if (!snapping) return;
    setIndex(0);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        setSnapping(false);
        setIndex(1);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [snapping]);

  // The track is one item tall per vendor plus the clone, so one step is
  // 100/(N+1) of its own height. Percentages are relative to the track.
  const offset = (index * 100) / (VENDORS.length + 1);

  return (
    <span className="vendor-roll" aria-hidden>
      <span
        className="vendor-roll-track"
        style={{
          transform: `translateY(-${offset}%)`,
          ...(snapping ? { transition: "none" } : null),
        }}
      >
        {VENDORS.map((v) => (
          <span key={v} className="vendor-roll-item">
            <span className="text-ember-word">{v}</span>
          </span>
        ))}
        {/* The clone. Same content as the first item, by construction. */}
        <span key="__clone" className="vendor-roll-item">
          <span className="text-ember-word">{VENDORS[0]}</span>
        </span>
      </span>
    </span>
  );
}

/** The one sentence a screen reader gets in place of the animation. */
export const VENDOR_ROLL_LABEL = `Your own ${VENDORS.slice(0, -1).join(", ")} or ${
  VENDORS[VENDORS.length - 1]
}.`;
