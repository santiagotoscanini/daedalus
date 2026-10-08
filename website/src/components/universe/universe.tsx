import { useEffect, useRef, useState } from "react";
import { iconUrl } from "~/data/icons";
import { SHOWN, type Service } from "~/data/services";

/** Everything it touches, as a wall: every integration and hosted app on one grid of glass tiles that
 * drifts, row against row. The wall is plain DOM in the prerender, so the icons are crisp vectors, the
 * names are real text, and nothing swaps in after first paint. Script only adds the motion and the
 * fade-in once the icons have decoded. One RAF clock drives it: the rows' ambient drift and the
 * scroll's push are summed, never traded, so scrolling cannot fight the drift. Hovering or focusing a
 * tile (a tap on a phone) lifts it, shows its name, dims the rest and slows the wall to a near stop.
 * Reduced motion: the same tiles as a still, wrapped grid. */

const SPEEDS = [19, -15, 23, -17, 20];

function rowsOf(list: Service[], n: number) {
  const rows: Service[][] = Array.from({ length: n }, () => []);
  list.forEach((s, i) => rows[i % n]!.push(s));
  return rows;
}

function Tile({ s, copy, sel, setSel, touch }: { s: Service; copy: boolean; sel: string | null; setSel: (id: string | null) => void; touch: boolean }) {
  return (
    <button
      type="button"
      className="uv-t"
      data-on={sel === s.id ? "" : undefined}
      aria-label={copy ? undefined : s.name}
      aria-hidden={copy || undefined}
      tabIndex={copy ? -1 : 0}
      title={copy ? undefined : s.name}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setSel(s.id);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setSel(null);
      }}
      onFocus={() => setSel(s.id)}
      onBlur={() => setSel(null)}
      onClick={() => {
        setSel(touch && sel === s.id ? null : s.id);
      }}
    >
      <span className="uv-glass">
        <img src={iconUrl(s.id)} alt="" width={44} height={44} decoding="async" draggable={false} />
      </span>
      <span className="uv-name" aria-hidden>
        {s.name}
      </span>
    </button>
  );
}

export function Universe() {
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"static" | "live" | "still">("static");
  const [ready, setReady] = useState(false);
  const [touch, setTouch] = useState(false);
  const [rowsN, setRowsN] = useState(4);
  const sec = useRef<HTMLElement>(null);
  const wall = useRef<HTMLDivElement>(null);
  const rowEls = useRef<Array<HTMLDivElement | null>>([]);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)").matches;
    setTouch(window.matchMedia("(hover: none)").matches);
    setRowsN(phone ? 5 : 4);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMode(reduced ? "still" : "live");
  }, []);

  // fade in once the marks have decoded, never before (a tile with no icon is never shown)
  useEffect(() => {
    const el = wall.current;
    if (!el) return;
    let off = false;
    const imgs = Array.from(el.querySelectorAll("img"));
    const done = Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
    const cap = new Promise((r) => setTimeout(r, 2500));
    void Promise.race([done, cap]).then(() => {
      if (!off) requestAnimationFrame(() => setReady(true));
    });
    return () => {
      off = true;
    };
  }, [rowsN]);

  // a name never leaves the screen: the label of a tile near an edge slides inward
  useEffect(() => {
    const n = wall.current?.querySelector<HTMLElement>("[data-on] .uv-name");
    if (!n) return;
    n.style.translate = "-50% 0";
    const b = n.getBoundingClientRect();
    const pad = 12;
    const dx = b.left < pad ? pad - b.left : b.right > window.innerWidth - pad ? window.innerWidth - pad - b.right : 0;
    if (dx) n.style.translate = `calc(-50% + ${dx}px) 0`;
  }, [sel]);

  useEffect(() => {
    if (mode !== "live") return;
    const section = sec.current;
    if (!section) return;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let pt = 0;
    let sp = 0;
    let fs = -1;
    let sf = 1;
    let widths: number[] = [];
    const measure = () => {
      widths = rowEls.current.map((r) => (r?.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(section);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      // the drift slows toward a near stop while a tile is held, and eases back
      sf += ((selRef.current ? 0.1 : 1) - sf) * (1 - Math.exp(-dt * 5));
      pt += dt * sf;
      const r = section.getBoundingClientRect();
      const target = -r.top / Math.max(1, window.innerHeight);
      if (fs < -50) fs = target;
      fs += (target - fs) * (1 - Math.exp(-dt * 8));
      sp = fs * 240;
      rowEls.current.forEach((row, i) => {
        const W = widths[i];
        if (!row || !W) return;
        const d = i % 2 ? -1 : 1;
        const speed = SPEEDS[i % SPEEDS.length]!;
        const p = Math.abs(speed) * pt * (speed > 0 ? 1 : 1) + sp * d + i * W * 0.31;
        const m = ((p % W) + W) % W;
        row.style.transform = d > 0 ? `translate3d(${(-m).toFixed(2)}px,0,0)` : `translate3d(${(m - W).toFixed(2)}px,0,0)`;
      });
    };
    fs = -999;
    raf = requestAnimationFrame(loop);
    // a tap outside the wall puts the name away
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".uv-t")) setSel(null);
    };
    window.addEventListener("pointerdown", away, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointerdown", away);
    };
  }, [mode, rowsN]);

  const rows = rowsOf(SHOWN, rowsN);

  return (
    <section ref={sec} id="universe" data-mode={mode} aria-labelledby="universe-title" className="uv relative">
      <div className="mx-auto max-w-6xl px-6 pt-24 sm:pt-32">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">What is in it</p>
        <h2 id="universe-title" className="mt-4 max-w-2xl text-balance text-[clamp(1.9rem,4vw,3rem)] font-semibold leading-[1.05] tracking-[-0.04em]">
          Everything it touches.
        </h2>
        <p className="mt-4 max-w-md text-pretty text-[15px] leading-relaxed text-muted">What it runs, and what it connects to.</p>
      </div>
      <div ref={wall} className="uv-wall" data-ready={ready ? "" : undefined} data-sel={sel ? "" : undefined}>
        <div className="uv-glow" aria-hidden />
        <div className="uv-plane">
          {rows.map((row, i) => (
            <div key={i} className="uv-rowclip">
              <div
                ref={(n) => {
                  rowEls.current[i] = n;
                }}
                className="uv-row"
              >
                <div className="uv-copy">
                  {row.map((s) => (
                    <Tile key={s.id} s={s} copy={false} sel={sel} setSel={setSel} touch={touch} />
                  ))}
                </div>
                {mode !== "still" && (
                  <div className="uv-copy" aria-hidden>
                    {row.map((s) => (
                      <Tile key={s.id} s={s} copy sel={sel} setSel={setSel} touch={touch} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <noscript>
        <style>{".uv-wall{opacity:1!important}"}</style>
      </noscript>
      <p className="mx-auto max-w-6xl px-6 pb-20 pt-6 text-[12px] leading-relaxed text-dim sm:pb-28">
        Logos are trademarks of their owners, shown only to say which service is meant.
      </p>
    </section>
  );
}
