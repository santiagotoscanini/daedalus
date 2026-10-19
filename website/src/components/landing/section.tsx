/** The landing's building blocks. Every section is one centred header block over exactly one
 * centred figure, so both are made here once: `Section` gives the page rhythm (160 / 128 / 96px
 * above each heading, no rule between sections) and names the region by its heading; `Header` sets
 * the heading, the intro of three lines or fewer under it, and, when the story runs longer, the
 * rest as a left-aligned prose block in the same centred 620 column; `Prose` sets story copy that
 * comes after a figure in that same column. `SectionLink` is the one way any page links to a landing
 * section. */

import { Link } from "@tanstack/react-router";
import { createContext, type MouseEvent, type ReactNode, useContext } from "react";
import { motionOn } from "~/components/landing/motion";

const SectionId = createContext<string | null>(null);

/** `<section id>` with the rhythm. The region is labelled by `{id}-title`, which `Header` puts on
 * its H2 (the hero, which has an H1 instead, gives its H1 that id itself). `end` adds the same air
 * below, for the last section before the footer. Children set their own `.wrap`, so a figure can
 * run full-bleed. */
export function Section({
  id,
  end = false,
  className,
  children,
}: {
  id: string;
  end?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const cls = ["section", end ? "section-end" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <SectionId.Provider value={id}>
      <section id={id} aria-labelledby={`${id}-title`} className={cls}>
        {children}
      </section>
    </SectionId.Provider>
  );
}

/** The centred header block: H2, 20px, intro; 24px, then the optional prose (a string, or an array
 * of paragraphs 20px apart). `titleLines` forces line breaks: each entry is its own block line and
 * replaces `title`. An intro given as an array sets each sentence on its own line and balances it
 * alone: balanced as one, two sentences break wherever the halves come out even, mid-phrase ("Then
 * a / cousin asks"). Put the figure after it with `.after-header` (64 / 56 / 40px). */
export function Header({
  title,
  titleLines,
  intro,
  prose,
  className,
}: {
  title?: ReactNode;
  titleLines?: ReactNode[];
  intro?: ReactNode | ReactNode[];
  prose?: ReactNode | ReactNode[];
  className?: string;
}) {
  const id = useContext(SectionId);
  const paragraphs = prose == null ? [] : Array.isArray(prose) ? prose : [prose];
  return (
    <div className={className ? `wrap ${className}` : "wrap"}>
      <h2 id={id ? `${id}-title` : undefined} className="t-h2">
        {titleLines
          ? titleLines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))
          : title}
      </h2>
      {intro != null && (
        <p className="t-intro mt-5">
          {Array.isArray(intro)
            ? intro.map((sentence, i) => (
                <span key={i} className="block">
                  {sentence}
                </span>
              ))
            : intro}
        </p>
      )}
      {paragraphs.length > 0 && (
        <div className="t-prose mt-6 flex flex-col gap-5">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Story copy that follows a figure: the same left-aligned 620 column as the header's prose, 48px
 * under the figure (`.after-figure`). A string, or an array of paragraphs 20px apart. A section
 * may also end with its figure and have none. */
export function Prose({ children, className }: { children: ReactNode | ReactNode[]; className?: string }) {
  const paragraphs = Array.isArray(children) ? children : [children];
  return (
    <div className={className ? `wrap after-figure ${className}` : "wrap after-figure"}>
      <div className="t-prose flex flex-col gap-5">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </div>
  );
}

const HASH_ONLY = { includeHash: true } as const;

/** A link to a landing section (`hash` is its id, without the #), from anywhere on the site. On the
 * landing it glides there itself (instantly under reduced motion) and puts the hash in the address
 * without a new history entry: the router would treat a second click on the same hash as no
 * navigation at all, and a page-wide smooth scroll also animated every route change. From another
 * page the router opens the landing at the section. Without script it is a plain `/#hash` link.
 * Every hash must be an id on the landing: scripts/check-anchors.mjs fails the build otherwise. */
export function SectionLink({
  hash,
  className,
  onClick,
  children,
}: {
  hash: string;
  className?: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (window.location.pathname !== "/") return;
    const el = document.getElementById(hash);
    if (!el) return;
    e.preventDefault();
    el.scrollIntoView({ behavior: motionOn() ? "smooth" : "auto", block: "start" });
    if (window.location.hash !== `#${hash}`) window.history.replaceState(window.history.state, "", `#${hash}`);
  };
  return (
    <Link to="/" hash={hash} activeOptions={HASH_ONLY} activeProps={{}} className={className} onClick={go}>
      {children}
    </Link>
  );
}
