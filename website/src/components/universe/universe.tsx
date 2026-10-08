import { useEffect, useRef, useState } from "react";
import { iconUrl } from "~/data/icons";
import { SHOWN, type Service } from "~/data/services";

/** Everything it touches, as a wall: every integration and hosted app on one grid of glass tiles that
 * drifts, row against row. The wall is plain DOM in the prerender, so the icons are crisp vectors and
 * nothing swaps in after first paint; script only adds the motion and the fade-in once the icons have
 * decoded. One RAF clock drives it: the rows' ambient drift and the scroll's push are summed, never
 * traded, so scrolling cannot fight the drift; sizes are cached and the scroll is read as scrollY, so
 * a frame costs no layout.
 *
 * Holding a tile (hover, focus, a tap) lifts it, freezes the wall, dims the rest, and shows its name
 * in ONE label that lives outside the wall's clipping and masking, placed from the tile's own box and
 * slid inward at the screen's edges. A tile's repeated copy (the wrap-around of the row) is its own
 * element: holding one highlights that one only.
 * Reduced motion: the same tiles as a still, wrapped grid. */

const SPEEDS = [19, 15, 23, 17, 20];

function rowsOf(list: Service[], n: number) {
  const rows: Service[][] = Array.from({ length: n }, () => []);
  list.forEach((s, i) => rows[i % n]!.push(s));
  return rows;
}

type Pick = (key: string | null, el?: HTMLElement, name?: string) => void;

function Tile({ s, copy, k, sel, pick, touch }: { s: Service; copy: boolean; k: string; sel: string | null; pick: Pick; touch: boolean }) {
  return (
    <button
      type="button"
      className="uv-t"
      data-on={sel === k ? "" : undefined}
      aria-label={copy ? undefined : s.name}
      aria-hidden={copy || undefined}
      tabIndex={copy ? -1 : 0}
      title={copy ? undefined : s.name}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") pick(k, e.currentTarget, s.name);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") pick(null);
      }}
      onFocus={(e) => pick(k, e.currentTarget, s.name)}
      onBlur={() => pick(null)}
      onClick={(e) => pick(touch && sel === k ? null : k, e.currentTarget, s.name)}
    >
      <span className="uv-glass">
        <img src={iconUrl(s.id)} alt="" width={44} height={44} decoding="async" draggable={false} />
      </span>
    </button>
  );
}

export function Universe() {
  const [sel, setSel] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"static" | "live" | "still">("static");
  const [ready, setReady] = useState(false);
  const [touch, setTouch] = useState(false);
  const [rowsN, setRowsN] = useState(4);
  const sec = useRef<HTMLElement>(null);
  const wall = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const rowEls = useRef<Array<HTMLDivElement | null>>([]);
  const selRef = useRef<string | null>(null);
  const selEl = useRef<HTMLElement | null>(null);
  selRef.current = sel;

  const pick: Pick = (key, el, nm) => {
    selEl.current = key ? (el ?? null) : null;
    if (nm) setName(nm);
    setSel(key);
  };

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)").matches;
    setTouch(window.matchMedia("(hover: none)").matches);
    setRowsN(phone ? 5 : 4);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setMode(reduced ? "still" : "live");
  }, []);

  // the one label: laid out from the held tile's box, inside the screen, never clipped
  useEffect(() => {
    const l = label.current;
    const s = sec.current;
    if (!l || !s) return;
    const el = sel ? selEl.current : null;
    if (!el) {
      l.removeAttribute("data-show");
      return;
    }
    const tb = el.getBoundingClientRect();
    const sb = s.getBoundingClientRect();
    const w = l.offsetWidth;
    const pad = 12;
    const cx = Math.min(window.innerWidth - pad - w / 2, Math.max(pad + w / 2, tb.left + tb.width / 2));
    l.style.transform = `translate3d(${(cx - w / 2 - sb.left).toFixed(1)}px, ${(tb.bottom - sb.top + 16).toFixed(1)}px, 0)`;
    l.setAttribute("data-show", "");
  }, [sel, name]);

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

  useEffect(() => {
    if (mode !== "live") return;
    const section = sec.current;
    if (!section) return;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let pt = 0;
    let fs = -999;
    let sf = 1;
    let top = 0;
    let widths: number[] = [];
    const measure = () => {
      widths = rowEls.current.map((r) => (r?.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0);
      top = section.getBoundingClientRect().top + window.scrollY;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(section);
    void document.fonts?.ready.then(measure);
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(section);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      if (selRef.current) {
        // held: the wall stands still, so the label stays under its tile
        sf = 0;
        return;
      }
      sf += (1 - sf) * (1 - Math.exp(-dt * 4));
      pt += dt * sf;
      const target = (window.scrollY - top) / Math.max(1, window.innerHeight);
      if (fs < -500) fs = target;
      fs += (target - fs) * (1 - Math.exp(-dt * 24));
      const sp = fs * 240;
      rowEls.current.forEach((row, i) => {
        const W = widths[i];
        if (!row || !W) return;
        const d = i % 2 ? -1 : 1;
        const p = (SPEEDS[i % SPEEDS.length] ?? 18) * pt + sp * d + i * W * 0.31;
        const m = ((p % W) + W) % W;
        row.style.transform = d > 0 ? `translate3d(${(-m).toFixed(2)}px,0,0)` : `translate3d(${(m - W).toFixed(2)}px,0,0)`;
      });
    };
    raf = requestAnimationFrame(loop);
    // a tap outside the wall puts the name away
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".uv-t")) pick(null);
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
                    <Tile key={s.id} s={s} copy={false} k={`${i}:${s.id}:0`} sel={sel} pick={pick} touch={touch} />
                  ))}
                </div>
                {mode !== "still" && (
                  <div className="uv-copy" aria-hidden>
                    {row.map((s) => (
                      <Tile key={s.id} s={s} copy k={`${i}:${s.id}:1`} sel={sel} pick={pick} touch={touch} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div ref={label} className="uv-label" aria-hidden>
        {name}
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
