import { Link } from "@tanstack/react-router";
import { Logo } from "~/components/logo";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** On every route: one row under the page's only rule, a full-bleed hairline. The mark and name at
 * the left, four plain links at the right; below 640 they stack as two centred lines. The mark is
 * 18 here against the bar's 20, so the gap is 12 against its 10: the two wordmarks share an x. Every
 * link here must resolve in the PUBLIC repo or on the site: open a link before adding it. */
export function Footer() {
  return (
    <footer className="border-t border-edge-2">
      <div className="wrap flex flex-col items-center gap-4 pb-8 pt-6 sm:h-[72px] sm:flex-row sm:justify-between sm:py-0">
        <div className="flex items-center gap-3">
          <Logo size={18} />
          <span className="wordmark">daedalus</span>
        </div>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 sm:gap-x-6">
            <li>
              <a href={REPO} className="foot-link">
                GitHub
              </a>
            </li>
            <li>
              <Link to="/docs" activeProps={{}} className="foot-link">
                Docs
              </Link>
            </li>
            <li>
              <Link to="/integrations" activeProps={{}} className="foot-link">
                Integrations
              </Link>
            </li>
            <li>
              <a href={`${REPO}/blob/main/LICENSE`} className="foot-link">
                MIT license
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
