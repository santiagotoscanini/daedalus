import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Logo } from "~/components/logo";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";

// Router Links with `to="/"` + hash (not bare `#loop` anchors) so they work
// from ANY page a future route might add — a bare hash elsewhere points at
// nothing and goes nowhere.
const links = [
  { label: "How it works", hash: "talk" },
  { label: "Made on it", hash: "made" },
  { label: "Get it", hash: "get" },
];

/** Slim full-width header: invisible over the hero, gaining a hairline
 * border + blur only once the page scrolls under it. Starts transparent on
 * the server and on the first client render (scrolled=false) so hydration
 * always agrees; a reload mid-page corrects on the first scroll event. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 border-b transition-colors duration-300 ${
        scrolled ? "border-hairline bg-app/80 backdrop-blur-md" : "border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-16 max-w-[75rem] items-center px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo size={20} />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">daedalus</span>
        </Link>

        <div className="ml-8 hidden items-center md:flex">
          {links.map((l) => (
            <Link
              key={l.hash}
              to="/"
              hash={l.hash}
              className="rounded-md px-3 py-1.5 text-[14px] text-muted transition-colors hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
          <Link to="/docs" className="rounded-md px-3 py-1.5 text-[14px] text-muted transition-colors hover:text-fg">
            Docs
          </Link>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Docs survives to phone widths: the section links are hidden there, and without it the
              header would offer no way to the site's other page. */}
          <Link to="/docs" className="rounded-md px-2 py-1.5 text-[14px] text-muted transition-colors hover:text-fg md:hidden">
            Docs
          </Link>
          <a href={REPO} className="btn btn-ghost btn-sm hidden sm:inline-flex">
            <Mark id="github" size={14} />
            GitHub
          </a>
          <Link to="/" hash="get" className="btn btn-primary btn-sm">
            Get started
          </Link>
        </div>
      </nav>
    </header>
  );
}
