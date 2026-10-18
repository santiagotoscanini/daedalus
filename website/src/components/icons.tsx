import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Every glyph on the page is one of these, never a text character: Geist's latin subset lacks the
 * arrows, ticks and chevrons, so a character would render in a fallback font. One grid for all of
 * them: 16 units, a 1.5 stroke in currentColor, round caps and joins. Drawn at 12 beside 13–15px
 * text and 10 beside 12px text; inline they sit on the text's centre (the vertical-align), and in a
 * flex row the row centres them. */
function Icon({ size = 12, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
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

/** Two sheets, one over the other: the copy action. */
export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </Icon>
  );
}

/** A tick, on the same grid as CopyIcon so one can replace the other in place. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </Icon>
  );
}

/** An arrow down into a tray. */
export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.5v8" />
      <path d="M4.75 7.25 8 10.5l3.25-3.25" />
      <path d="M2.5 11v1A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </Icon>
  );
}

/** Onward, within the site. */
export function ArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 8h11" />
      <path d="M9 3.5 13.5 8 9 12.5" />
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

/** Send. */
export function ArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 13.5v-11" />
      <path d="M3.5 7 8 2.5 12.5 7" />
    </Icon>
  );
}

/** Open a list or a disclosure. */
export function ChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6l4 4 4-4" />
    </Icon>
  );
}

/** The certificate in front of an address. */
export function Lock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Icon>
  );
}

/** A prompt: the coding agent on the box. */
export function Terminal(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5 6.5 8 3 11.5" />
      <path d="M8.5 11.5H13" />
    </Icon>
  );
}
