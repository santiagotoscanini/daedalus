/** The "coming" mark: a hollow ring in front of anything that is next rather than built. One
 * component, used identically everywhere, so the page has a single visual word for "not yet": the
 * empty counterpart of the green light that means live.
 *
 * It is centred on the middle of the capitals, never on the x-height. The first ring was the size
 * of Geist's lowercase o and sat on the baseline, so every caveat read as a typo ("o Today you
 * ask…"); one as tall as the capitals read as a capital O. At 8px across, a shade dimmer than the
 * words and 6px clear of them, it reads as a marker in the margin of the line, as the founder's own
 * ○ does. A dashed ring was tried and dropped: eight dashes read as a loading spinner, worst inside
 * a button. The ring is solid and static. Ring and gap advance 16px, so a caption that hangs its
 * second line under the words indents by 16.
 *
 * `ComingLine` is the left-aligned form: the ring in its own column and every line of the words in
 * the next, so a second line starts under the first word, never under the ring. A centred line
 * keeps the plain inline mark, since a hanging indent cannot centre. */

import type { ReactNode } from "react";

export function Coming() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="coming">
      <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
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
