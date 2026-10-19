/** The tree's words: the nine questions every app has to answer, the answers daedalus gives, and the
 * five example requests the reader can switch between. Seven answers are the house's and never
 * change; the last two are read off the request, so each request names the words that settle them.
 *
 * The option counts are our estimate (the figure's description says so). Every number on the
 * section, from 46,656 down to 1, is computed from `n` below, never typed.
 *
 * Row 1 holds for every request, Sitter's included: the sign-in is the family's, and a page shared
 * by link (the babysitter's) opens without one. */

import type { AppId } from "~/components/landing/app-icon";

export type Column = {
  /** The question, in sentence case. */
  q: string;
  /** How many ways it could be answered. */
  n: number;
  /** The house's answer (columns 1-7 only; 8 and 9 come from the request). */
  a?: string;
  /** What runs it, for the "Under the hood" readout (columns 1-7 only). */
  under?: string;
};

export const COLUMNS: readonly Column[] = [
  {
    q: "How people sign in",
    n: 4,
    a: "Face or fingerprint, one sign-in for the family",
    under: "Pocket ID passkeys; a page shared by link needs no sign-in",
  },
  { q: "Where its data lives", n: 4, a: "Its own database, at home", under: "Postgres, snapshotted every hour" },
  {
    q: "Which AI it can use",
    n: 4,
    a: "The house’s AI, already connected",
    under: "a LiteLLM gateway to your graphics card or a frontier lab, one key",
  },
  {
    q: "Who builds it",
    n: 3,
    a: "Built automatically, on every change",
    under: "Railpack + BuildKit on the box, and Xcode on GitHub’s Macs for iPhone apps",
  },
  { q: "How people reach it", n: 3, a: "Its own address, secured", under: "DNS + HTTPS certificate" },
  { q: "Who keeps an eye on it", n: 3, a: "Checks, around the clock", under: "Health checks + alerts" },
  { q: "If a change goes wrong", n: 3, a: "One step back", under: "NixOS generations + git" },
  { q: "Where you want it", n: 3 },
  { q: "Who it’s for", n: 3 },
];

/** Which option the house keeps in columns 1-7 (drawn top to bottom). Spread over the fan so the
 * cuts read as choices, not as "always the first one". */
export const HOUSE_KEEP = [1, 2, 0, 1, 2, 0, 1] as const;

/** Column 8's and column 9's options, in fan order: the request picks one of each. */
export const WHERE = ["iPhone", "Mac", "The web"] as const;
export const WHO = ["Just you", "The family", "Anyone with a link"] as const;

export type Request = {
  app: AppId;
  name: string;
  /** What you said, without the quotation marks. */
  text: string;
  /** The words that settle column 8, then column 9 (whole words, case-sensitive). */
  words: readonly [readonly string[], readonly string[]];
  /** Index into WHERE, then into WHO. */
  keep: readonly [number, number];
  /** The finished app, said plainly. */
  end: string;
};

export const REQUESTS: readonly Request[] = [
  {
    app: "pinch",
    name: "Pinch",
    text: "Can you make us an iPhone app for Grandma’s recipe cards? Scan them, keep her handwriting, and let the family add notes.",
    words: [["iPhone app"], ["the family"]],
    keep: [0, 1],
    end: "Pinch, on the family’s iPhones",
  },
  {
    app: "backpack",
    name: "Backpack",
    text: "Read the kids’ school emails and tell me on my phone what needs a signature.",
    words: [["on my phone"], ["tell me"]],
    keep: [0, 0],
    end: "Backpack, on your iPhone",
  },
  {
    app: "pillbox",
    name: "Pillbox",
    text: "Remind Dad to take his evening pills, and tell me if he hasn’t by nine.",
    words: [["Remind"], ["Dad", "me"]],
    keep: [0, 1],
    end: "Pillbox, on your iPhone and Dad’s",
  },
  {
    app: "sitter",
    name: "Sitter",
    text: "A page for the babysitter with bedtimes, allergies and who to call.",
    words: [["A page"], ["for the babysitter"]],
    keep: [2, 2],
    end: "Sitter, on the web for anyone with the link",
  },
  {
    app: "doorframe",
    name: "Doorframe",
    text: "Keep track of how tall the kids are, from a photo of the door frame.",
    words: [["a photo"], ["the kids"]],
    keep: [0, 1],
    end: "Doorframe, on the family’s iPhones",
  },
];

/** A request cut into runs of plain text and settling words: `mark` is 1 for a word that settles
 * column 8, 2 for column 9, 0 for the rest. */
export type Segment = { text: string; mark: 0 | 1 | 2 };

function segments(r: Request): Segment[] {
  const hits: { at: number; len: number; mark: 1 | 2 }[] = [];
  const letter = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  r.words.forEach((list, i) => {
    for (const w of list) {
      // whole words only: "me" must not light inside "Remind" or "time"
      let at = r.text.indexOf(w);
      while (at >= 0 && (letter(r.text[at - 1]) || letter(r.text[at + w.length]))) at = r.text.indexOf(w, at + 1);
      if (at < 0) throw new Error(`"${w}" is not a whole word of the ${r.name} request`);
      hits.push({ at, len: w.length, mark: (i + 1) as 1 | 2 });
    }
  });
  hits.sort((a, b) => a.at - b.at);
  const out: Segment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.at > pos) out.push({ text: r.text.slice(pos, h.at), mark: 0 });
    out.push({ text: r.text.slice(h.at, h.at + h.len), mark: h.mark });
    pos = h.at + h.len;
  }
  if (pos < r.text.length) out.push({ text: r.text.slice(pos), mark: 0 });
  return out;
}

export const SEGMENTS: readonly Segment[][] = REQUESTS.map(segments);

/** Thousands separators without the runtime's locale data, so the prerender and the browser agree. */
export function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
