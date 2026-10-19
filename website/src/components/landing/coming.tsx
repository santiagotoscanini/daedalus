/** The "coming" mark: a dashed ring in front of anything that is next rather than built. One
 * component, used identically everywhere, so the page has a single visual word for "not yet", and
 * it is the same dashed line as the tree's ghost and the rack's empty slot: planned, not there.
 *
 * It is drawn at cap height, never at x-height. The first ring was the size of Geist's lowercase o
 * and sat on the baseline, so every caveat read as a typo ("o Today you ask…"); a solid ring the
 * height of the capitals read as an O instead. Dashed, it cannot pass for a letter. Its eight
 * dashes are centred on the points of the compass, so the ring is symmetric, and its centre sits
 * on the middle of the capitals (styles.css, .coming). It takes the colour of the text it leads
 * (always ink-4). Ring and gap advance 16px, so a caption that hangs its second line under the
 * words indents by 16.
 *
 * `ComingLine` is the left-aligned form: the ring in its own column and every line of the words in
 * the next, so a second line starts under the first word, never under the ring. A centred line
 * keeps the plain inline mark, since a hanging indent cannot centre. */

import type { ReactNode } from "react";

export function Coming() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="coming">
      {/* 8 dashes of 1.2 on a 16-unit path, turned back half a dash so one is centred at 3 o'clock */}
      <circle
        cx="5"
        cy="5"
        r="4.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        pathLength="16"
        strokeDasharray="1.2 0.8"
        transform="rotate(-13.5 5 5)"
      />
    </svg>
  );
}

/** A left-aligned line led by the mark, its wrapped lines hanging under the words. `as` picks the
 * element (a `p` by default); the type comes from `className` (`t-caption`, or the context's own). */
export function ComingLine({
  as: Tag = "p",
  className,
  children,
}: {
  as?: "p" | "div" | "li" | "span";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={className ? `coming-line ${className}` : "coming-line"}>
      <span className="coming-lead">
        <Coming />
      </span>
      <span className="coming-text">{children}</span>
    </Tag>
  );
}
