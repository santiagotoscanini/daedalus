import { useEffect, useState } from "react";
import { BrandMark } from "~/components/brand-marks";

/** The hero's rolling headline: the services this box replaces, sliding
 * up one at a time under their own mark.
 *
 * Every name here has something real behind it — apps platform, pocket-id,
 * the prometheus/grafana/loki stack, immich, nextcloud, jellyfin, and the
 * lemonade/litellm/open-webui chain. Nothing is listed that the box does
 * not actually run.
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
 *    long name like "Google Photos" changes nothing above or below it.
 *    That is why the width is free to vary and needs no animation. */

const VENDORS = [
  "Vercel",
  "AWS",
  "GCP",
  "Heroku",
  "Auth0",
  "Datadog",
  "Google Photos",
  "iCloud",
  "Dropbox",
  "Netflix",
  "ChatGPT",
  "Claude",
];

const HOLD_MS = 1900;

export function VendorRoll() {
  const [index, setIndex] = useState(0);
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

  useEffect(() => {
    if (!running || document.hidden) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % VENDORS.length), HOLD_MS);
    return () => window.clearTimeout(id);
  }, [running, index]);

  // The track is one item tall per vendor, so one step is 100/N of its own
  // height. Percentages here are relative to the track, not to an item.
  const offset = (index * 100) / VENDORS.length;

  return (
    <span className="vendor-roll" aria-hidden>
      <span className="vendor-roll-track" style={{ transform: `translateY(-${offset}%)` }}>
        {VENDORS.map((v) => (
          <span key={v} className="vendor-roll-item">
            <BrandMark name={v} className="vendor-roll-mark" />
            <span className="text-ember-word">{v}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** The one sentence a screen reader gets in place of the animation. */
export const VENDOR_ROLL_LABEL = `Your own ${VENDORS.slice(0, -1).join(", ")} or ${
  VENDORS[VENDORS.length - 1]
}. On one box.`;
