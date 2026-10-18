import { AppsCompact, AppsView } from "./views/apps-view";

const LABEL =
  "The daedalus Apps page: a new app, almacen, arrives at the top of the table building, then running, above the apps the box already runs.";

/** The hero's picture of the app, in two densities. From 1024px: the fixed 1280×800 canvas of the
 * hand-built Apps view, zoomed by `--demo-scale` (written on `.hero-shot`, see use-fit-scale.ts)
 * and cropped by a 2:1 frame to its top 640 design px. Below 1024: the compact list at 1:1. Both
 * frames are the page's `.hero-frame`, which carries the edge and dissolves the bottom; the app's
 * own rail and inset panel are the only chrome, so there is no title bar. Every label is real text,
 * so the canvas zooms losslessly and the prerendered HTML carries it. */
export function DemoWindow() {
  return (
    <>
      <div data-product role="img" aria-label={LABEL} className="hero-frame hidden aspect-[2/1] lg:block">
        <div className="demo-canvas pointer-events-none select-none text-left max-lg:hidden">
          <AppsView />
        </div>
      </div>
      {/* 352, not 360, below 640: it keeps the phone hero, window included, within 1,050px */}
      <div data-product role="img" aria-label={LABEL} className="hero-frame h-[352px] sm:h-[440px] lg:hidden">
        <AppsCompact />
      </div>
    </>
  );
}
