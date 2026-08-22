import { Link } from "@tanstack/react-router";
import { GitHubLogo } from "~/components/icons";
import { Logo } from "~/components/logo";

const REPO = "https://github.com/santiagotoscanini/daedalus";

// Router Links with `to="/"` + hash (not bare `#loop` anchors) so they work
// from ANY page a future route might add — a bare hash elsewhere points at
// nothing and goes nowhere.
const links = [
  { label: "The idea", hash: "cloud" },
  { label: "The pages", hash: "features" },
  { label: "How it works", hash: "loop" },
];

/** Floating nav: a detached, rounded, blurred bar inset from the top —
 * the page scrolls underneath it. */
export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-4 pt-4">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between rounded-2xl border border-line bg-app/70 pl-5 pr-3 backdrop-blur-xl">
        <Link to="/" className="flex items-center gap-2.5 font-semibold">
          <Logo size={20} />
          <span className="text-[15px] tracking-tight">daedalus</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.hash}
              to="/"
              hash={l.hash}
              className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
          <a
            href={`${REPO}/tree/main/docs`}
            className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            Docs
          </a>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={REPO}
            aria-label="daedalus on GitHub"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            <GitHubLogo size={17} />
          </a>
          <a href={REPO} className="btn btn-primary hidden h-9 px-3.5 text-[13px] sm:inline-flex">
            View on GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}
