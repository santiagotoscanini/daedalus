import { Link } from "@tanstack/react-router";
import { Logo } from "~/components/logo";

const REPO = "https://github.com/santiagotoscanini/daedalus";

const link = "t-small transition-colors duration-(--d-1) ease-ui hover:text-ink-1";
const head = "t-small font-medium text-ink-1";
// t-small on the list, not only on the links: each row is then a 20px line box, and with the 12px
// gap the rows sit on a 32px pitch (inheriting the root's 16/24 line made it 36).
const list = "t-small mt-4 flex flex-col gap-3";

/** On every route, on the band: on the landing it continues the Get started band below the close,
 * divided from it by a rule at the column's width. Brand in columns 1–6, Project in 7–9, Site in
 * 10–12; below 1024px the brand sits on top and the two lists side by side. Every Site hash must be
 * an id on the landing: scripts/check-anchors.mjs fails the build otherwise. */
export function Footer() {
  return (
    <footer className="band">
      <div className="wrap">
        <div className="border-t border-edge-1 pb-8 pt-12 sm:pb-10 sm:pt-14 lg:pt-16">
          <div className="grid-12 max-lg:grid max-lg:grid-cols-2 max-lg:gap-x-6 max-lg:gap-y-12">
            <div className="max-lg:col-span-2 lg:col-span-6">
              <div className="flex items-center gap-2.5">
                <Logo size={18} />
                <span className="wordmark">daedalus</span>
              </div>
              <p className="t-small mt-4 max-w-[320px]">Software, made for one, on the computers you already own.</p>
            </div>
            <nav aria-label="Project" className="lg:col-span-3">
              <p className={head}>Project</p>
              <ul className={list}>
                <li>
                  <a href={REPO} className={link}>
                    GitHub
                  </a>
                </li>
                <li>
                  <Link to="/docs" className={link}>
                    Docs
                  </Link>
                </li>
                <li>
                  <Link to="/integrations" className={link}>
                    Integrations
                  </Link>
                </li>
                {/* Every link in this list must resolve in the PUBLIC repo. The
                    two that used to sit here pointed at docs/operations.md and
                    docs/recovery.md, which exist only in the private machine
                    configuration: both 404'd, from the footer of every page, for
                    as long as the site has been up. Open a link before adding it.

                    The two below carry Mermaid diagrams and stay in the repo
                    rather than on the site: GitHub renders Mermaid natively, while
                    shipping a renderer here would cost ~900 KB gzip against a
                    103 KB site, could not prerender, and would make a second copy
                    of facts like uid numbers and request filenames that nobody
                    would think to re-check. */}
                <li>
                  <a href={`${REPO}/blob/main/ARCHITECTURE.md`} className={link}>
                    Architecture
                  </a>
                </li>
                <li>
                  <a href={`${REPO}/blob/main/BUILDS.md`} className={link}>
                    Builds
                  </a>
                </li>
                <li>
                  <a href={`${REPO}/blob/main/PLAN.md`} className={link}>
                    Plan
                  </a>
                </li>
              </ul>
            </nav>
            <nav aria-label="Site" className="lg:col-span-3">
              <p className={head}>Site</p>
              <ul className={list}>
                <li>
                  <Link to="/" hash="made" className={link}>
                    Made on it
                  </Link>
                </li>
                <li>
                  <Link to="/" hash="how" className={link}>
                    How it works
                  </Link>
                </li>
                <li>
                  <Link to="/" hash="home" className={link}>
                    Why at home
                  </Link>
                </li>
                <li>
                  <Link to="/" hash="faq" className={link}>
                    Questions
                  </Link>
                </li>
                <li>
                  <Link to="/" hash="get" className={link}>
                    Get started
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <div className="t-small mt-16 flex flex-wrap justify-between gap-3 border-t border-edge-1 pt-6 text-ink-4">
            <p>© 2026 daedalus</p>
            <p>
              Made at home by{" "}
              <a href="https://toscanini.me" className="text-ink-2 transition-colors duration-(--d-1) ease-ui hover:text-ink-1">
                Santiago Toscanini
              </a>
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
