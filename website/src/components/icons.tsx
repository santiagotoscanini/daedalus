import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Every glyph on the page is one of these, never a text character: Geist's latin subset lacks the
 * arrows, ticks and chevrons, so a character would render in a fallback font. One grid for all of
 * them: 16 units, a 1.5 stroke in currentColor, round caps and joins. Drawn at 12 beside 13–15px
 * text and 10 beside 12px text; inline they sit on the text's centre (the vertical-align), and in a
 * flex row the row centres them. A glyph drawn on a smaller grid (the 12-unit chevron) says so with
 * `grid`, and its own stroke with `stroke`. */
function Icon({
  size = 12,
  className,
  grid = 16,
  stroke = 1.5,
  children,
}: IconProps & { grid?: number; stroke?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `shrink-0 ${className}` : "shrink-0"}
      style={{ verticalAlign: "-0.125em" }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** A tick: a step that went through, in the record. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </Icon>
  );
}

/** Out, to another site. */
export function ArrowUpRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 11.5l7-7" />
      <path d="M5.5 4.5h6v6" />
    </Icon>
  );
}

/** Run it again: the tree's Replay. */
export function Replay({ size = 12, className }: IconProps) {
  return (
    <Icon size={size} className={className}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
      <path d="M2.5 2.5v3h3" />
    </Icon>
  );
}

/** A disclosure, closed; it turns 90° to open. On a 12-unit grid, drawn at 10. */
export function ChevronRight({ size = 10, className }: IconProps) {
  return (
    <Icon size={size} className={className} grid={12} stroke={1.4}>
      <path d="M4 2.5 7.5 6 4 9.5" />
    </Icon>
  );
}
