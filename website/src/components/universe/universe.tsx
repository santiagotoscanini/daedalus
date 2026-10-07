import { useEffect, useRef, useState } from "react";
import { iconUrl } from "~/data/icons";
import { SHOWN } from "~/data/services";
import type { UniverseScene } from "./scene";

/** Everything it touches: the hosted apps and integrations as one field of cubes, each carrying the
 * service's own mark. The page is complete without the scene: the prerender, a reader with no script,
 * a browser with no WebGL and reduced motion get the roster (the same names with their marks). Once
 * hydrated and near, the scene's chunk and the marks load, and if the GL context comes up the stage
 * pins and the scroll flies the camera through it (scene.ts); with reduced motion it renders one
 * finished frame and keeps the roster. */

type Mode = "static" | "pinned" | "still";
/** svh of scroll the flight takes, beyond the stage itself */
const RUN = 420;

export function Universe() {
  const [mode, setMode] = useState<Mode>("static");
  const [ready, setReady] = useState(false);
  const sec = useRef<HTMLElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labelEls = useRef<Array<HTMLSpanElement | null>>([]);
  const scene = useRef<UniverseScene | null>(null);

  useEffect(() => {
    const section = sec.current;
    const el = canvas.current;
    const box = holder.current;
    if (!section || !el || !box) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mobile = window.matchMedia("(max-width: 767px)").matches;
    let cancelled = false;
    let raf = 0;
    let visible = true;
    let started = false;
    let last = performance.now();
    let fs = -1;
    let alive: UniverseScene | null = null;

    const fit = () => alive?.resize(box.clientWidth, box.clientHeight);
    const ro = new ResizeObserver(() => {
      fit();
      if (reduced && alive) alive.renderStill();
    });

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!alive || !visible || document.hidden) return;
      const r = section.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      const target = run > 0 ? Math.min(1, Math.max(0, -r.top / run)) : 0;
      if (fs < 0) fs = target;
      fs += (target - fs) * (1 - Math.exp(-dt * 6));
      if (Math.abs(target - fs) < 0.00005) fs = target;
      alive.setProgress(fs);
      alive.tick(dt);
      const L = alive.labels;
      labelEls.current.forEach((n, i) => {
        if (!n) return;
        const l = L[i];
        if (!l) {
          n.style.opacity = "0";
          return;
        }
        const nm = alive!.names[l.index] ?? "";
        if (n.textContent !== nm) n.textContent = nm;
        n.style.opacity = l.a.toFixed(3);
        n.style.transform = `translate3d(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px, 0)`;
      });
    };

    const boot = async () => {
      if (started) return;
      started = true;
      try {
        const { createUniverse } = await import("./scene");
        if (cancelled) return;
        const items = SHOWN.filter((_, i) => !mobile || i % 2 === 0 || SHOWN[i]!.focus).map((s) => ({
          id: s.id,
          name: s.name,
          url: iconUrl(s.id),
          focus: s.focus,
        }));
        const sc = await createUniverse({ canvas: el, items, mobile, onReady: () => setReady(true) });
        if (cancelled) {
          sc.dispose();
          return;
        }
        alive = sc;
        scene.current = sc;
        if (reduced) {
          setMode("still");
        } else {
          setMode("pinned");
          raf = requestAnimationFrame(loop);
        }
        ro.observe(box);
        requestAnimationFrame(() => {
          fit();
          if (reduced) alive?.renderStill();
        });
      } catch {
        // no GL, or a blocked context: the roster stands
      }
    };

    const near = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) void boot();
      },
      { rootMargin: "250% 0px" },
    );
    near.observe(section);
    const vis = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    vis.observe(box);
    const move = (e: PointerEvent) => alive?.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
    window.addEventListener("pointermove", move, { passive: true });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      near.disconnect();
      vis.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", move);
      alive?.dispose();
      scene.current = null;
    };
  }, []);

  return (
    <section
      ref={sec}
      id="universe"
      data-mode={mode}
      data-ready={ready ? "" : undefined}
      aria-labelledby="universe-title"
      className="uv relative"
      style={mode === "pinned" ? { height: `${RUN + 100}svh` } : undefined}
    >
      <div ref={holder} className="uv-stage" aria-hidden>
        <canvas ref={canvas} className="uv-canvas" />
        <div className="uv-vignette" />
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            ref={(n) => {
              labelEls.current[i] = n;
            }}
            className="uv-label"
          />
        ))}
        <div className="uv-head">
          <p className="uv-kicker">What is in it</p>
          <p className="uv-title">Everything it touches.</p>
          <p className="uv-line">What it runs, and what it connects to.</p>
        </div>
        <p className="uv-legal">Logos are trademarks of their owners, shown only to say which service is meant.</p>
      </div>
      <Roster sr={mode === "pinned"} still={mode === "still"} />
    </section>
  );
}

/** The names with their marks: the section itself for the static and reduced-motion cases, screen-reader
 * only while the field flies. */
function Roster({ sr, still }: { sr: boolean; still: boolean }) {
  return (
    <div className={sr ? "sr-only" : "uv-roster mx-auto max-w-6xl px-6 py-20 sm:py-28"}>
      <div className={still ? "sr-only" : ""}>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">What is in it</p>
      <h2 id="universe-title" className="mt-3 max-w-2xl text-balance text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[1.06] tracking-[-0.035em]">
        Everything it touches.
      </h2>
      <p className="mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-muted">What it runs, and what it connects to.</p>
      </div>
      <ul className="mt-12 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        {SHOWN.map((s) => (
          <li key={s.id} className="flex items-center gap-3 text-[13.5px] text-[#d4d4db]">
            <span className="uv-chip">{sr ? null : <img src={iconUrl(s.id)} alt="" loading="lazy" width={26} height={26} />}</span>
            <span className="min-w-0 truncate">{s.name}</span>
          </li>
        ))}
      </ul>
      <p className="mt-12 max-w-xl text-[12.5px] leading-relaxed text-dim">
        Logos are trademarks of their owners, shown only to say which service is meant.
      </p>
    </div>
  );
}
