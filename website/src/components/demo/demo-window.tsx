import { useRef } from "react";
import { DESIGN_H, DESIGN_W, useFitScale } from "./use-fit-scale";
import { AppsView } from "./views/apps-view";
import { DeploysView } from "./views/deploys-view";
import { UpdatesView } from "./views/updates-view";

export type DemoView = "apps" | "deploys" | "updates";

/** What a screen reader is told each picture shows. */
const ARIA: Record<DemoView, string> = {
  apps: "The daedalus Apps page: a table of eight apps with their address, exposure, requests per minute and last deploy, and an Apply bar with one change waiting.",
  deploys:
    "An app's Deployments page: a build in progress at the repository's checks, the builds before it, and the deploys where the image digest moved.",
  updates:
    "The System page's Updates tab: the machines linked to the box, the engine's pinned revision, and four containers behind their registry, one opened to its update button.",
};

function ViewBody({ view }: { view: DemoView }) {
  switch (view) {
    case "apps":
      return <AppsView />;
    case "deploys":
      return <DeploysView />;
    default:
      return <UpdatesView />;
  }
}

/** One screen of the app: the fixed 1280×800 canvas of the hand-built view,
 * scaled to fit its container. Every label is real text, so the window
 * scales losslessly and the prerendered HTML carries it. */
export function DemoWindow({ view }: { view: DemoView }) {
  const fitRef = useRef<HTMLDivElement>(null);
  useFitScale(fitRef);

  return (
    <div
      ref={fitRef}
      role="img"
      aria-label={ARIA[view]}
      className="demo-fit relative aspect-16/10 w-full overflow-hidden rounded-[14px] border border-line shadow-[0_1px_1px_rgba(0,0,0,0.45),0_30px_80px_-20px_rgba(0,0,0,0.85),0_0_140px_-50px_rgba(226,121,90,0.35)]"
    >
      <div
        className="demo-canvas pointer-events-none absolute left-1/2 top-1/2 select-none text-left"
        style={{ width: DESIGN_W, height: DESIGN_H }}
      >
        <ViewBody view={view} />
      </div>
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07)" }}
        aria-hidden
      />
    </div>
  );
}
