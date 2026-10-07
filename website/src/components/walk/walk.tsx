import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DemoWindow, type DemoView } from "~/components/demo/demo-window";
import { Labyrinth } from "~/components/labyrinth";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The vendors the page opens by crossing out: the same six, in the same
 * order, as the receipt below (rented-cloud.tsx). */
const RECEIPT = ["Vercel", "Heroku", "Auth0", "Datadog", "Docker Hub", "Supabase"];

/** The hero and its signature scroll: the mark's labyrinth as a real place,
 * and the page walks it.
 *
 * One pinned stage holds the canvas and four stations. Scrolling is the
 * camera: from the mouth, inward as a push is built, up over the box where
 * the other machines link, and out again as the deploy lands on an app. The
 * three windows are the app's real screens (the demo views), each at the
 * station whose beat it shows.
 *
 * The page is complete without any of it. The prerendered HTML carries the
 * hero and the three stations stacked in the normal flow; a poster of the
 * labyrinth sits where the canvas will be; the 3D chunk loads after first
 * paint and only then does the stage pin. With no WebGL the poster stands.
 * With reduced motion the canvas renders one composed frame and the
 * stations stay stacked. */

const STATIONS: Array<{
  kicker: string;
  title: string;
  body: ReactNode;
  facts: string[];
  view: DemoView;
}> = [
  {
    kicker: "01 · Push",
    title: "A push walks in, and the walls light as it builds.",
    body: (
      <>
        A GitHub App tells the box. It builds the image itself with Railpack, runs the repo's own
        checks inside the build, and pushes the result to its own registry. A new app costs one
        rebuild, and nothing exists for it until its first image does.
      </>
    ),
    facts: ["Railpack or your Dockerfile", "Checks run in the build", "The box's own registry"],
    view: "deploys",
  },
  {
    kicker: "02 · The box",
    title: "One machine at the centre, and yours on the other end.",
    body: (
      <>
        Your other machines link to it over TLS, each side pinning the other's key, and nothing is
        sent to one until an admin approves it. Every container is pinned by digest: an update is a
        commit, a rebuild and a check that it came back.
      </>
    ),
    facts: ["Windows, macOS, Linux", "An outbound link per machine", "Approved in Settings"],
    view: "updates",
  },
  {
    kicker: "03 · Deploy",
    title: "The deploy walks out and lands on an app.",
    body: (
      <>
        When the digest moves, the app restarts on the new image. Each app sits at a stage: Off runs
        and nothing can reach it, Lab is the LAN only, Public is also on the internet, through a
        tunnel.
      </>
    ),
    facts: ["Off", "Lab", "Public"],
    view: "apps",
  },
];

const LABEL_TEXT: Record<string, string> = {
  push: "git push origin main",
  box: "the box",
  mac: "Mac · pinned TLS",
  pc: "PC · pinned TLS",
  app: "lintel · deployed",
};

/** Where each station is on, in scroll share: in start, in end, out start,
 * out end. Station 0 is the hero, 1..3 the windows. */
const WINDOWS: Array<[number, number, number, number]> = [
  [-1, -0.5, 0.13, 0.23],
  [0.27, 0.33, 0.47, 0.53],
  [0.55, 0.61, 0.73, 0.79],
  [0.82, 0.88, 2, 3],
];

const span = (f: number, a: number, b: number) => Math.min(1, Math.max(0, (f - a) / (b - a)));
const smooth = (x: number) => x * x * (3 - 2 * x);

type Mode = "static" | "pinned" | "still";

export function Walk() {
  const sec = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stations = useRef<Array<HTMLDivElement | null>>([]);
  const rail = useRef<Array<HTMLSpanElement | null>>([]);
  const labels = useRef(new Map<string, HTMLElement>());
  const [mode, setMode] = useState<Mode>("static");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMode(reduced ? "still" : "pinned");
  }, []);

  useEffect(() => {
    if (mode === "static") return;
    const el = canvas.current;
    const holder = stage.current;
    const section = sec.current;
    if (!el || !holder || !section) return;
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    let scene: import("./scene").WalkScene | null = null;
    let cancelled = false;
    let raf = 0;
    let visible = true;
    let fs = 0;
    let last = performance.now();
    let booted = false;

    const fit = () => scene?.resize(holder.clientWidth, holder.clientHeight);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      const r = section.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      const target = run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
      // the camera and the copy ease toward the scroll, frame-rate independent,
      // so a flick and a crawl, up or down, both land without a step
      fs += (target - fs) * (1 - Math.exp(-dt * 7));
      if (Math.abs(target - fs) < 0.00004) fs = target;
      if (mode === "pinned") drive(fs);
      scene?.setProgress(fs);
      scene?.tick(dt);
    };

    const drive = (f: number) => {
      stations.current.forEach((s, i) => {
        if (!s) return;
        const w = WINDOWS[i]!;
        const inn = smooth(span(f, w[0], w[1]));
        const out = smooth(span(f, w[2], w[3]));
        const o = inn * (1 - out);
        s.style.opacity = o.toFixed(3);
        s.style.pointerEvents = o > 0.6 ? "auto" : "none";
        // the copy leaves upward, the next arrives from below; the window tilts the same way
        const t = (1 - inn) - out;
        s.style.setProperty("--t", t.toFixed(3));
        s.style.setProperty("--y", `${(((1 - inn) * 46 - out * 46)).toFixed(1)}px`);
      });
      const active = WINDOWS.findIndex((w, i) => f >= (i === 0 ? 0 : w[0] + 0.02) && f < (WINDOWS[i + 1]?.[0] ?? 9) + 0.02);
      rail.current.forEach((d, i) => d?.toggleAttribute("data-on", i === (active < 0 ? 0 : active)));
    };

    const boot = async () => {
      if (booted) return;
      booted = true;
      try {
        const mod = await import("./scene");
        if (cancelled) return;
        scene = mod.createScene({
          canvas: el,
          light: mobile,
          labelEls: labels.current,
          onReady: () => setReady(true),
          onLost: () => {
            scene?.dispose();
            scene = null;
            setReady(false);
          },
        });
        fit();
        if (mode === "still") scene.renderStill();
      } catch {
        // no WebGL2: the poster stands
        scene = null;
      }
    };

    // first paint stays light: the 3D chunk waits for the browser to be idle, or the first touch
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => number })
      .requestIdleCallback;
    const kick = idle ? idle(() => void boot(), { timeout: 1800 }) : window.setTimeout(() => void boot(), 900);
    const early = () => void boot();
    window.addEventListener("pointerdown", early, { once: true, passive: true });
    window.addEventListener("scroll", early, { once: true, passive: true });

    const ro = new ResizeObserver(() => {
      fit();
      if (mode === "still") scene?.renderStill();
    });
    ro.observe(holder);

    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(section);

    const onPointer = (e: PointerEvent) => {
      scene?.setPointer((e.clientX / window.innerWidth - 0.5) * 2, (e.clientY / window.innerHeight - 0.5) * 2);
    };
    if (!mobile && mode === "pinned") window.addEventListener("pointermove", onPointer, { passive: true });

    if (mode === "pinned") {
      drive(0);
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (idle) (window as unknown as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback?.(kick);
      else clearTimeout(kick);
      window.removeEventListener("pointerdown", early);
      window.removeEventListener("scroll", early);
      window.removeEventListener("pointermove", onPointer);
      ro.disconnect();
      io.disconnect();
      scene?.dispose();
      scene = null;
    };
  }, [mode]);

  return (
    <section
      ref={sec}
      id="walk"
      data-mode={mode}
      data-ready={ready ? "" : undefined}
      className="walk relative"
      style={mode === "pinned" ? { height: "560svh" } : undefined}
    >
      {/* The stage: the canvas, its poster, the labels anchored to things */}
      <div ref={stage} className="walk-stage" aria-hidden>
        <Poster />
        <canvas ref={canvas} className="walk-canvas" />
        <div className="walk-vignette" />
        {Object.entries(LABEL_TEXT).map(([id, text]) => (
          <span
            key={id}
            ref={(n) => {
              if (n) labels.current.set(id, n);
              else labels.current.delete(id);
            }}
            className="walk-label"
          >
            <span>{text}</span>
          </span>
        ))}
      </div>

      <div className="walk-stations">
        <Station i={0} refs={stations}>
          <div className="mx-auto w-full max-w-6xl px-6">
            <div className="hero-copy max-w-[46rem]">
              <p className="rise font-mono text-[11px] uppercase tracking-[0.2em] text-muted-2">
                Open source · MIT · pre-release
              </p>
              <h1 className="rise mt-5 text-[clamp(2.6rem,6.4vw,5.8rem)] font-semibold leading-[0.92] tracking-[-0.05em] sm:mt-7">
                <span className="block">Build yourself</span>
                <span className="block">a cloud.</span>
              </h1>
              {/* The receipt: what a rented cloud is, crossed out as the page opens */}
              <p className="rise rise-1 mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 font-mono text-[12px] text-dim sm:mt-8 sm:text-[12.5px]">
                <span className="sr-only">Instead of {RECEIPT.join(", ")}.</span>
                {RECEIPT.map((v, i) => (
                  <span
                    key={v}
                    aria-hidden
                    className="hero-strike"
                    style={{ ["--d" as string]: `${1.5 + i * 0.16}s` }}
                  >
                    {v}
                  </span>
                ))}
              </p>
              <p className="rise rise-2 mt-6 max-w-[33rem] text-pretty text-[15.5px] leading-relaxed text-[#b4b4be] sm:mt-8 sm:text-[17px]">
                A control plane for one machine you own. It builds and deploys your apps, gives them
                a database and a login when they ask for one, and watches all of it. Every change it
                makes is a commit to the machine's NixOS configuration.
              </p>
              <div className="rise rise-3 mt-7 flex flex-wrap items-center gap-3 sm:mt-10">
                <a href={REPO} className="btn btn-primary h-11 px-5">
                  View on GitHub
                </a>
                <Link to="/" hash="get" className="btn btn-ghost h-11 px-5">
                  Get it
                </Link>
              </div>
            </div>
          </div>
          <p className="walk-cue" aria-hidden>
            <span>Scroll to walk in</span>
            <i />
          </p>
        </Station>

        {STATIONS.map((s, k) => (
          <Station key={s.kicker} i={k + 1} refs={stations}>
            <div className="mx-auto grid w-full max-w-6xl items-end gap-x-12 gap-y-5 px-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
              <div className="station-copy">
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">
                  {s.kicker}
                </p>
                <h2 className="mt-3 text-balance text-[clamp(1.45rem,2.9vw,2.35rem)] font-semibold leading-[1.08] tracking-[-0.03em]">
                  {s.title}
                </h2>
                <p className="mt-4 text-pretty text-[14px] leading-relaxed text-[#a8a8b3] sm:text-[15px]">
                  {s.body}
                </p>
                <ul className="mt-5 hidden gap-1.5 border-t border-hairline pt-4 font-mono text-[11.5px] text-muted sm:grid">
                  {s.facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
              <div className="station-win lg:w-[min(100%,41rem)] lg:justify-self-end">
                <DemoWindow view={s.view} />
              </div>
            </div>
          </Station>
        ))}

        {/* The rail: where in the walk */}
        <div className="walk-rail" aria-hidden>
          {["Mouth", "Push", "Box", "Deploy"].map((n, i) => (
            <span
              key={n}
              ref={(el) => {
                rail.current[i] = el;
              }}
            >
              {n}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Station({
  i,
  refs,
  children,
}: {
  i: number;
  refs: React.RefObject<Array<HTMLDivElement | null>>;
  children: ReactNode;
}) {
  return (
    <div
      ref={(el) => {
        refs.current[i] = el;
      }}
      className="station"
      data-i={i}
    >
      {children}
    </div>
  );
}

/** What stands in for the canvas until it has drawn, and where there is no
 * GL: the mark's own line, stacked into a few courses and laid down in
 * perspective, drawing itself in from the centre in CSS. */
function Poster() {
  return (
    <div className="walk-poster">
      <div className="walk-poster-plan">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{ transform: `translateZ(${i * 7}px)`, opacity: 0.16 + i * 0.13 }}
          >
            <Labyrinth draw={i === 4} className="w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
