import { useRef } from "react";
import { DESIGN_H, DESIGN_W, useFitScale } from "./use-fit-scale";
import { AppsView } from "./views/apps-view";

/** One screen of the app: the fixed 1280×800 canvas of the hand-built Apps view, scaled to fit its
 * container. Every label is real text, so the window scales losslessly and the prerendered HTML
 * carries it. */
export function DemoWindow() {
  const fitRef = useRef<HTMLDivElement>(null);
  useFitScale(fitRef);

  return (
    <div
      ref={fitRef}
      role="img"
      aria-label="The daedalus Apps page: a new app, almacen, arrives at the top of the table building, then running, above the apps the box already runs."
      className="demo-fit relative aspect-16/10 w-full overflow-hidden rounded-[12px] border border-line-2 shadow-[0_0_0_1px_#000,0_40px_100px_-30px_rgba(0,0,0,0.9)]"
    >
      <div
        className="demo-canvas pointer-events-none absolute left-1/2 top-1/2 select-none text-left"
        style={{ width: DESIGN_W, height: DESIGN_H }}
      >
        <AppsView />
      </div>
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07)" }}
        aria-hidden
      />
    </div>
  );
}
