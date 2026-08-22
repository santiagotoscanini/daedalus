import { Link } from "@tanstack/react-router";
import { Logo } from "~/components/logo";

const REPO = "https://github.com/santiagotoscanini/daedalus";

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto grid max-w-5xl gap-12 px-6 py-16 sm:grid-cols-[1fr_auto_auto] sm:gap-24">
        <div>
          <div className="flex items-center gap-2.5 font-semibold">
            <Logo size={18} />
            <span className="text-[15px] tracking-tight">daedalus</span>
          </div>
          <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-muted">
            Daedalus — a cloud of your own, on one box. NixOS is the backend that keeps it
            reproducible.
          </p>
        </div>
        <nav aria-label="Project">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">Project</p>
          <ul className="mt-4 space-y-2.5 text-[13px] text-muted">
            <li>
              <a href={REPO} className="transition-colors hover:text-fg">
                GitHub
              </a>
            </li>
            <li>
              <Link to="/docs" className="transition-colors hover:text-fg">
                Docs
              </Link>
            </li>
            <li>
              <a
                href={`${REPO}/blob/main/docs/operations.md`}
                className="transition-colors hover:text-fg"
              >
                Operations
              </a>
            </li>
            <li>
              <a
                href={`${REPO}/blob/main/docs/recovery.md`}
                className="transition-colors hover:text-fg"
              >
                Recovery
              </a>
            </li>
          </ul>
        </nav>
        <nav aria-label="Site">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">Site</p>
          <ul className="mt-4 space-y-2.5 text-[13px] text-muted">
            <li>
              <Link to="/" hash="cloud" className="transition-colors hover:text-fg">
                The idea
              </Link>
            </li>
            <li>
              <Link to="/" hash="features" className="transition-colors hover:text-fg">
                The pages
              </Link>
            </li>
            <li>
              <Link to="/" hash="loop" className="transition-colors hover:text-fg">
                How it works
              </Link>
            </li>
            <li>
              <Link to="/" hash="principles" className="transition-colors hover:text-fg">
                Principles
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-hairline">
        <p className="mx-auto max-w-5xl px-6 py-6 font-mono text-[11px] text-dim">
          © 2026 daedalus · one unbroken line
        </p>
      </div>
    </footer>
  );
}
