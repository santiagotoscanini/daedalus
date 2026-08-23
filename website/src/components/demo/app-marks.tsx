import type { ReactNode } from "react";

/** The marks the fleet's own apps serve at `/icon.svg`, redrawn inline.
 *
 * daedalus fetches each app's icon from the app itself and falls back to a
 * monogram only when it answers with none (see `src/lib/app-icon.ts` in the
 * app). A demo built entirely out of monograms therefore shows the failure
 * mode rather than the product, so the seven apps that ship a mark carry it
 * here.
 *
 * Hand-copied from each app's own icon, like the rest of `demo/` — the
 * landing is a static build with no network, so it cannot fetch what the
 * real UI fetches. Sources: `stacks/pocket-id/assets/logos/<name>.svg` for
 * six of them, `public/icon.svg` in the chismed repo for the seventh. Resync
 * by hand if a mark is redrawn.
 *
 * Three deliberate departures from the source files:
 *
 *  - Gradient ids are prefixed `mark-<app>-`. The originals are standalone
 *    documents where a bare `sheen` is unambiguous; inlined into a page that
 *    holds seven of them, an unprefixed id is a collision, and SVG resolves
 *    `url(#id)` against the whole document.
 *  - anansi's `<style>` block is gone, its rules moved onto the elements. It
 *    styled the bare selector `svg`, which inside an inline SVG is not scoped
 *    to that SVG — it would repaint every other mark on the page. Its
 *    `prefers-color-scheme` pair collapses to the dark arm, the only one this
 *    chrome ever shows.
 *  - anansi and voyra draw on transparency in their own apps; here they get
 *    the tile their siblings already carry, so a row of icons reads as one
 *    set instead of two floating glyphs.
 */

interface MarkSpec {
  viewBox: string;
  body: ReactNode;
}

const MARKS: Record<string, MarkSpec> = {
  anansi: {
    viewBox: "0 0 100 100",
    body: (
      <>
        <rect width="100" height="100" rx="22" fill="#1c1408" />
        <g
          fill="none"
          stroke="#f3ead4"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="50" y1="50" x2="50" y2="10" />
          <line x1="50" y1="50" x2="78.3" y2="21.7" />
          <line x1="50" y1="50" x2="90" y2="50" />
          <line x1="50" y1="50" x2="78.3" y2="78.3" />
          <line x1="50" y1="50" x2="50" y2="90" />
          <line x1="50" y1="50" x2="21.7" y2="78.3" />
          <line x1="50" y1="50" x2="10" y2="50" />
          <line x1="50" y1="50" x2="21.7" y2="21.7" />
          <polygon points="50,10 78.3,21.7 90,50 78.3,78.3 50,90 21.7,78.3 10,50 21.7,21.7" />
          <polygon points="50,26 67,33 74,50 67,67 50,74 33,67 26,50 33,33" />
        </g>
        <circle cx="50" cy="50" r="4.5" fill="#b06a3b" />
      </>
    ),
  },

  argus: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <defs>
          <linearGradient
            id="mark-argus-sheen"
            x1="5"
            y1="5"
            x2="27"
            y2="27"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#00d4aa" />
            <stop offset=".52" stopColor="#29b6ff" />
            <stop offset="1" stopColor="#7c5cff" />
          </linearGradient>
          <radialGradient
            id="mark-argus-pupil"
            cx="16"
            cy="16"
            r="6"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#7c5cff" />
            <stop offset="1" stopColor="#150d31" />
          </radialGradient>
        </defs>
        <rect width="32" height="32" rx="7" fill="#060908" />
        <circle
          cx="16"
          cy="16"
          r="11.3"
          fill="none"
          stroke="url(#mark-argus-sheen)"
          strokeWidth="1.5"
          opacity=".5"
        />
        <circle
          cx="16"
          cy="16"
          r="8.2"
          fill="none"
          stroke="url(#mark-argus-sheen)"
          strokeWidth="2.1"
        />
        <circle
          cx="16"
          cy="16"
          r="4.9"
          fill="url(#mark-argus-pupil)"
          stroke="#00d4aa"
          strokeWidth="1.3"
        />
        <circle cx="14.3" cy="14.3" r="1.15" fill="#eafffa" />
      </>
    ),
  },

  chismed: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <rect width="64" height="64" rx="14" fill="#181613" />
        <text
          x="32"
          y="46"
          textAnchor="middle"
          fontFamily="system-ui, sans-serif"
          fontWeight="800"
          fontSize="40"
          letterSpacing="-3"
          fill="#f4ede0"
        >
          ch<tspan fill="#ff3d8b">.</tspan>
        </text>
      </>
    ),
  },

  daedalus: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <rect width="32" height="32" rx="7" fill="#e2795a" />
        <path
          d="M16 16 L16 20 L12 20 L12 12 L20 12 L20 24 L8 24 L8 8 L24 8 L24 28 L4 28 L4 4 L28 4"
          fill="none"
          stroke="#fdf3ef"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },

  hermes: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <rect width="64" height="64" rx="14" fill="#b8543a" />
        <path d="M8 40h40" fill="none" stroke="#fdf7f2" strokeWidth="5" strokeLinecap="round" />
        <path
          d="M19 40V30M31 40V16M43 40V26"
          fill="none"
          stroke="#fdf7f2"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle cx="54" cy="40" r="4.5" fill="#fdf7f2" />
      </>
    ),
  },

  iris: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <rect width="32" height="32" rx="7" fill="#1b1815" />
        <g fill="#faf6f0">
          <path d="M6 6h9v9H6V6Zm2.5 2.5v4h4v-4h-4Z" />
          <path d="M17 6h9v9h-9V6Zm2.5 2.5v4h4v-4h-4Z" />
          <path d="M6 17h9v9H6v-9Zm2.5 2.5v4h4v-4h-4Z" />
        </g>
        <g fill="#c24c2c">
          <rect x="17" y="17" width="4" height="4" rx="1" />
          <rect x="22" y="22" width="4" height="4" rx="1" />
          <rect x="22" y="17" width="2" height="2" rx="0.6" />
          <rect x="17" y="22" width="2" height="2" rx="0.6" />
        </g>
      </>
    ),
  },

  voyra: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <defs>
          <linearGradient
            id="mark-voyra-v"
            x1="14"
            y1="8"
            x2="50"
            y2="56"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#863BFF" />
            <stop offset="1" stopColor="#5C3FDF" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="14" fill="#0f0d18" />
        <path
          d="M4 47 C 16 25 38 15 61 20"
          fill="none"
          stroke="#8B7BE8"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="0.5 6"
          opacity="0.85"
        />
        <path d="M8 10 H24 L32 33 L40 10 H56 L37 54 H27 Z" fill="url(#mark-voyra-v)" />
        <circle cx="61" cy="20" r="3" fill="#863BFF" />
      </>
    ),
  },
};

/** Whether this app ships a mark, i.e. whether the real UI would show one. */
export function hasAppMark(name: string): boolean {
  return name in MARKS;
}

/** One app's mark, clipped to the same corner radius the monogram tile uses. */
export function AppMark({ name, size = 22 }: { name: string; size?: number }) {
  const mark = MARKS[name];
  if (mark === undefined) return null;
  return (
    <svg
      viewBox={mark.viewBox}
      width={size}
      height={size}
      aria-hidden
      className="block shrink-0"
      style={{ borderRadius: Math.round(size * 0.22) }}
    >
      {mark.body}
    </svg>
  );
}
