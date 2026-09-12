import { useEffect, useRef, useState } from "react";
import { DESIGN_H, DESIGN_W, useFitScale } from "./use-fit-scale";
import { AppsView } from "./views/apps-view";
import { DeploysView } from "./views/deploys-view";
import { MonitoringView } from "./views/monitoring-view";
import { UpdatesView } from "./views/updates-view";

export type DemoView = "fleet" | "deploys" | "monitoring" | "updates";

export const DEMO_VIEWS: Array<{ id: DemoView; label: string; aria: string }> = [
  {
    id: "fleet",
    label: "Fleet",
    aria: "The daedalus apps view: six self-built apps listed with status, hostname, exposure and traffic, and an Apply bar with one pending change.",
  },
  {
    id: "deploys",
    label: "Deploys",
    aria: "An app's deployments tab: a build running on the box and a timeline of deploys, including one failure.",
  },
  {
    id: "monitoring",
    label: "Monitoring",
    aria: "The monitoring view: headline stats, a probe list where a dead probe reads as unknown rather than healthy, and one firing alert.",
  },
  {
    id: "updates",
    label: "Updates",
    aria: "The system updates view: containers behind their registry tag with changelogs and a one-at-a-time update button.",
  },
];

function ViewBody({ view }: { view: DemoView }) {
  switch (view) {
    case "fleet":
      return <AppsView />;
    case "deploys":
      return <DeploysView />;
    case "monitoring":
      return <MonitoringView />;
    default:
      return <UpdatesView />;
  }
}

/** One demo window: the fixed 1280×800 canvas scaled to fit, framed with
 * unscaled edge lighting so the hairline stays crisp at any size. */
export function DemoWindow({ view, live = false }: { view: DemoView; live?: boolean }) {
  const fitRef = useRef<HTMLDivElement>(null);
  useFitScale(fitRef);
  const meta = DEMO_VIEWS.find((v) => v.id === view);

  return (
    <div
      ref={fitRef}
      role="img"
      aria-label={meta?.aria}
      className="demo-fit relative aspect-16/10 w-full overflow-hidden rounded-xl border border-hairline shadow-[0_1px_1px_rgba(0,0,0,0.45),0_24px_60px_-16px_rgba(0,0,0,0.65),0_48px_120px_-24px_rgba(0,0,0,0.8),0_0_120px_-40px_rgba(226,121,90,0.3)]"
    >
      <div
        className="demo-canvas pointer-events-none absolute left-1/2 top-1/2 select-none text-left"
        style={{ width: DESIGN_W, height: DESIGN_H }}
      >
        {live ? (
          // All views mounted, crossfading — every label is in the
          // prerendered HTML, and switching never re-lays-out.
          DEMO_VIEWS.map((v) => (
            <div
              key={v.id}
              className="absolute inset-0 transition-opacity duration-300"
              style={{ opacity: v.id === view ? 1 : 0 }}
              aria-hidden={v.id !== view}
            >
              <ViewBody view={v.id} />
            </div>
          ))
        ) : (
          <ViewBody view={view} />
        )}
      </div>
      {/* Edge lighting: unscaled so it stays 1px crisp at every fit scale. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
        aria-hidden
      />
      {/* Bottom dissolve into the page. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[9%] bg-linear-to-b from-transparent to-app/70"
        aria-hidden
      />
    </div>
  );
}

/** The hero demo: a pill selector over a live window. Auto-advances until
 * the visitor touches it, then it's theirs. */
export function AppDemo() {
  const [view, setView] = useState<DemoView>("fleet");
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      setView((v) => {
        const i = DEMO_VIEWS.findIndex((d) => d.id === v);
        return DEMO_VIEWS[(i + 1) % DEMO_VIEWS.length]?.id ?? "fleet";
      });
    }, 7000);
    return () => clearInterval(t);
  }, [held]);

  return (
    <div onPointerEnter={() => setHeld(true)}>
      {/* Toggle buttons in a labelled group, NOT `role="tablist"` + `role="tab"`.
          A tab has to own a tabpanel, and what these switch is one
          `role="img"` — an element cannot be both. Announced as tabs, a screen
          reader offered "tab, 1 of 4" and then had nowhere to go, and the
          arrow-key navigation the role promises was never implemented.
          `aria-pressed` describes exactly what these are.

          Sized down below sm because this row is the one thing on the page
          that could not shrink: at 360px the four labels ran 381px wide inside
          a 312px gutter, and the hero's `overflow-hidden` sliced "UPDATES" in
          half. `max-w-full overflow-x-auto` is the floor under that — narrower
          still, it scrolls instead of clipping. */}
      <div
        className="mx-auto mb-5 flex w-fit max-w-full justify-center gap-0.5 overflow-x-auto rounded-full border border-line bg-white/[0.03] p-1 sm:gap-1"
        role="group"
        aria-label="Views of the app"
      >
        {DEMO_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            aria-pressed={view === v.id}
            onClick={() => {
              setHeld(true);
              setView(v.id);
            }}
            className={`shrink-0 rounded-full px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors sm:px-3.5 sm:text-[11px] sm:tracking-[0.14em] ${
              view === v.id ? "bg-white/[0.08] text-fg" : "text-muted-2 hover:text-fg"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <DemoWindow view={view} live />
    </div>
  );
}
