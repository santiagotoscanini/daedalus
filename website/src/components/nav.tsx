import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Logo } from "~/components/logo";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";

// Router Links with `to="/"` + hash (not bare `#made` anchors) so they work
// from ANY page — a bare hash elsewhere points at nothing and goes nowhere.
// Every hash here must be an id on the landing: scripts/check-anchors.mjs
// fails the build otherwise. In page order.
const links = [
  { label: "Made on it", hash: "made" },
  { label: "How it works", hash: "how" },
];

const link = "t-small transition-colors duration-(--d-1) ease-ui hover:text-ink-1";
// On /docs the Docs link reads as the current page; the router adds aria-current="page" itself.
const current = { className: "text-ink-1" };

/** The bar: fixed, 64px, on the same column as the page (logo at x=120, the button ending at x=1320
 * at 1440). Transparent over the hero; once the page scrolls under it, it takes a fill and a 1px
 * edge, never a blur. The fill is the page's until the closing band reaches the bar's bottom edge,
 * then the band's, so the band reads as one tone up to the bar. From the moment the close's filled
 * button ("View on GitHub") comes on screen to the end of the page, this one is secondary: no
 * screen shows two, and below that button this one would point at the section the reader is
 * already in. It waits for that button rather than the close's top edge: switching when the band
 * came into view left a whole screen (the end of the questions, the close's heading) with no filled
 * button at all. Starts transparent and primary on the server and on the first client render so
 * hydration always agrees; a reload mid-page corrects on mount or on the first scroll event. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [onBand, setOnBand] = useState(false);
  const [yields, setYields] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
      // The page ends on one band (the close and then the footer on the landing, the footer alone
      // elsewhere), so the first .band is where it starts. 64 is the bar's height.
      const band = document.querySelector(".band")?.getBoundingClientRect();
      setOnBand(!!band && band.top <= 64);
      // Read on every scroll rather than observed: the button is found again after a client-side
      // route change, with no observer to re-attach. Elsewhere there is no close, and no yielding.
      const theirs = document.querySelector("#get .btn-primary")?.getBoundingClientRect();
      setYields(!!theirs && theirs.top < window.innerHeight);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-[background-color,box-shadow] duration-(--d-2) ease-ui ${
        scrolled ? `${onBand ? "bg-raise-1" : "bg-page"} shadow-[0_1px_0_var(--color-edge-2)]` : ""
      }`}
    >
      <nav className="wrap flex h-16 items-center">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo size={20} />
          <span className="wordmark">daedalus</span>
        </Link>

        <div className="ml-8 hidden items-center gap-6 md:flex">
          {links.map((l) => (
            <Link key={l.hash} to="/" hash={l.hash} className={link}>
              {l.label}
            </Link>
          ))}
          <Link to="/docs" className={link} activeProps={current}>
            Docs
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-5">
          {/* Docs survives to phone widths: the section links are hidden there, and without it the
              header would offer no way to the site's other page. */}
          <Link to="/docs" className={`${link} md:hidden`} activeProps={current}>
            Docs
          </Link>
          <a href={REPO} className={`${link} hidden items-center gap-1.5 sm:inline-flex`}>
            <Mark id="github" size={14} />
            GitHub
          </a>
          <Link to="/" hash="get" className={`btn btn-sm ${yields ? "btn-secondary" : "btn-primary"}`}>
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}
