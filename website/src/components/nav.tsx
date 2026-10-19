import { Link, useLocation } from "@tanstack/react-router";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { motionOn } from "~/components/landing/motion";
import { SectionLink } from "~/components/landing/section";
import { Logo } from "~/components/logo";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";

// Section links work from any page (SectionLink). Every hash here must be an id on the landing:
// scripts/check-anchors.mjs fails the build otherwise.
const SECTIONS = [
  { label: "Apps", hash: "made" },
  { label: "How it works", hash: "decisions" },
] as const;

/** The bar: fixed, 64px, on the page's column. Logo and wordmark at the left edge; the three page
 * links centred on the page's own axis (x=720 at 1440), not between their neighbours; GitHub and a
 * secondary "Get started" at the right, so the hero's own button stays the one filled button on
 * screen. Transparent over the hero; past 8px of scroll it takes a translucent fill, a blur and a
 * hairline (styles.css, .nav-bar). Below 768 the links fold into a <details> sheet that covers the
 * viewport under the bar while the page under it holds still; it opens without script, and with
 * script it also closes on a link, Escape, an outside tap or a route change.
 * The server renders the top state; a reload mid-page corrects on mount. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const sheet = useRef<HTMLDetailsElement>(null);
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const d = sheet.current;
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !d.open) return;
      d.open = false;
      d.querySelector("summary")?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (d.open && e.target instanceof Node && !d.contains(e.target)) d.open = false;
    };
    // The sheet covers the page under the bar, so its empty part (the panel, or the list's gutters)
    // is the outside. Closed on the click, not the pointerdown, so the tap ends on the sheet and
    // never lands on a link that was under it.
    const panel = d.querySelector(".nav-panel");
    const onPanel = (e: Event) => {
      if (d.open && panel && (e.target === panel || e.target === panel.firstElementChild)) d.open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, { passive: true });
    panel?.addEventListener("click", onPanel);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      panel?.removeEventListener("click", onPanel);
    };
  }, []);

  // a navigation (including a hash on the same page) always leaves the sheet closed
  useEffect(() => {
    if (sheet.current) sheet.current.open = false;
  }, [location.pathname, location.hash]);

  const close = () => {
    if (sheet.current) sheet.current.open = false;
  };
  // on the landing the mark goes back to the top (the router sees no navigation in "/" to "/")
  const toTop = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || window.location.pathname !== "/") return;
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: motionOn() ? "smooth" : "auto" });
    if (window.location.hash) window.history.replaceState(window.history.state, "", "/");
  };

  return (
    <header className="nav-bar fixed inset-x-0 top-0 z-40" data-scrolled={scrolled ? "" : undefined}>
      <nav aria-label="Main" className="wrap relative flex h-16 items-center">
        {/* 20px of mark and name in a 32px box like every control in the bar (the padding is taken
            back by the margin, so the ring clears the mark and the name), 44 to a finger (.hit) */}
        <Link
          to="/"
          onClick={toTop}
          className="hit z-10 -mx-2 -my-1.5 flex items-center gap-2.5 rounded-control px-2 py-1.5"
        >
          <Logo size={20} />
          <span className="wordmark">daedalus</span>
        </Link>

        {/* Centred by layout on the full bar, not by a transform, so the text lands on whole pixels. */}
        <div className="pointer-events-none absolute inset-0 hidden items-center justify-center gap-8 md:flex">
          {SECTIONS.map((s) => (
            <SectionLink key={s.hash} hash={s.hash} className="nav-link pointer-events-auto">
              {s.label}
            </SectionLink>
          ))}
          <Link to="/docs" activeProps={{}} className="nav-link pointer-events-auto">
            Docs
          </Link>
        </div>

        <div className="relative z-10 ml-auto flex items-center gap-4">
          <a href={REPO} aria-label="daedalus on GitHub" className="nav-icon hidden md:grid">
            <Mark id="github" size={18} />
          </a>
          <SectionLink hash="start" className="btn btn-secondary btn-sm">
            Get started
          </SectionLink>
          <details ref={sheet} className="nav-sheet -ml-2 md:hidden">
            <summary aria-label="Menu">
              <span className="nav-burger" aria-hidden>
                <span />
                <span />
              </span>
            </summary>
            <div className="nav-panel">
              <ul className="wrap">
                {SECTIONS.map((s) => (
                  <li key={s.hash}>
                    <SectionLink hash={s.hash} onClick={close}>
                      {s.label}
                    </SectionLink>
                  </li>
                ))}
                <li>
                  <Link to="/docs" activeProps={{}} onClick={close}>
                    Docs
                  </Link>
                </li>
                <li>
                  <a href={REPO} onClick={close}>
                    GitHub
                  </a>
                </li>
              </ul>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
