import { useEffect, useRef, useState } from "react";
import { DESIGN_H, DESIGN_W, useFitScale } from "./use-fit-scale";
import { AppsView } from "./views/apps-view";
import { DeploysView } from "./views/deploys-view";
import { UpdatesView } from "./views/updates-view";

export type DemoView = "apps" | "deploys" | "updates";

/** Each view: its switch label, what a screen reader is told the picture
 * shows, and the one line under the window that says what it is for. The
 * caption carries the claim, so the page never needs a second tour of the
 * same screens further down. */
export const DEMO_VIEWS: Array<{ id: DemoView; label: string; aria: string; caption: string }> = [
  {
    id: "apps",
    label: "Apps",
    aria: "The daedalus Apps page: a table of eight apps with their address, exposure, requests per minute and last deploy, and an Apply bar with one change waiting.",
    caption:
      "Every app on the box in one table. A change waits in the Apply bar until you apply it.",
  },
  {
    id: "deploys",
    label: "Deploys",
    aria: "An app's Deployments page: a build in progress at the repository's checks, the builds before it, and the deploys where the image digest moved.",
    caption:
      "A push to main is built on the box with Railpack, checked, and deployed when the digest moves.",
  },
  {
    id: "updates",
    label: "Updates",
    aria: "The System page's Updates tab: the machines linked to the box, the engine's pinned revision, and four containers behind their registry, one opened to its update button.",
    caption:
      "Every container is pinned by digest. An update is a commit, a rebuild and a check that it came back.",
  },
];

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

/** The window: the fixed 1280×800 canvas scaled to fit, every view mounted
 * and crossfaded, so all the labels are in the prerendered HTML and a
 * switch never re-lays-out. */
function DemoWindow({ view }: { view: DemoView }) {
  const fitRef = useRef<HTMLDivElement>(null);
  useFitScale(fitRef);
  const meta = DEMO_VIEWS.find((v) => v.id === view);

  return (
    <div
      ref={fitRef}
      role="img"
      aria-label={meta?.aria}
      className="demo-fit relative aspect-16/10 w-full overflow-hidden rounded-[14px] border border-line shadow-[0_1px_1px_rgba(0,0,0,0.45),0_30px_80px_-20px_rgba(0,0,0,0.85),0_0_140px_-50px_rgba(226,121,90,0.35)]"
    >
      <div
        className="demo-canvas pointer-events-none absolute left-1/2 top-1/2 select-none text-left"
        style={{ width: DESIGN_W, height: DESIGN_H }}
      >
        {DEMO_VIEWS.map((v) => (
          <div
            key={v.id}
            className="absolute inset-0 transition-opacity duration-500"
            style={{ opacity: v.id === view ? 1 : 0 }}
            aria-hidden={v.id !== view}
          >
            <ViewBody view={v.id} />
          </div>
        ))}
      </div>
      <div
        className="pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07)" }}
        aria-hidden
      />
    </div>
  );
}

/** The hero demo: the window, a switch under it, and the caption for the
 * view in front. Auto-advances until the visitor touches it. */
export function AppDemo() {
  const [view, setView] = useState<DemoView>("apps");
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => {
      if (document.hidden) return;
      setView((v) => {
        const i = DEMO_VIEWS.findIndex((d) => d.id === v);
        return DEMO_VIEWS[(i + 1) % DEMO_VIEWS.length]?.id ?? "apps";
      });
    }, 7000);
    return () => clearInterval(t);
  }, [held]);

  const current = DEMO_VIEWS.find((v) => v.id === view) ?? DEMO_VIEWS[0]!;

  return (
    <div onPointerEnter={() => setHeld(true)}>
      <DemoWindow view={view} />
      <div className="mt-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between sm:gap-8">
        {/* Toggle buttons in a labelled group, not tabs: what they switch is
            one `role="img"`, which cannot also be a tabpanel. */}
        <div
          className="flex shrink-0 gap-1 rounded-full border border-line bg-white/[0.02] p-1"
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
              className={`rounded-full px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                view === v.id ? "bg-white/[0.08] text-fg" : "text-muted-2 hover:text-fg"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <p
          className="min-h-[2lh] max-w-md text-pretty text-center text-[13.5px] leading-relaxed text-muted sm:min-h-0 sm:text-right"
          aria-live="polite"
        >
          {current.caption}
        </p>
      </div>
    </div>
  );
}
