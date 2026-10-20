import { type CSSProperties, useEffect, useRef, useState } from "react";
import { iconUrl } from "~/data/icons";
import { SHOWN, type Service } from "~/data/services";

/** Everything it touches, as a wall: every integration and hosted app on one still grid of glass
 * tiles, under the /integrations page's own heading. The wall is plain DOM in the prerender, so the
 * icons are crisp vectors and nothing swaps in after first paint; script only fades it in once the
 * icons have decoded. Nothing on it moves: it is a reference, not a show.
 *
 * Holding a tile (hover, focus, a tap) steps its fill, dims the rest, and shows its name in ONE label
 * that lives outside the wall's clipping, placed from the tile's own box and slid inward at the
 * screen's edges. */

type Pick = (key: string | null, el?: HTMLElement, name?: string) => void;

/** The column count in [lo, hi] whose last row is fullest (a full last row counts as 1, so a count
 * that divides the tiles evenly wins; a tie goes to the wider grid). The wall steps its columns with
 * the viewport, and choosing each step's count from the number of tiles means a tile added to or
 * dropped from services.ts never leaves one or two on a row of their own. */
function pickCols(n: number, lo: number, hi: number): number {
  let best = hi;
  let fill = -1;
  for (let c = hi; c >= lo; c--) {
    const f = n % c === 0 ? 1 : (n % c) / c;
    if (f > fill + 0.001) {
      best = c;
      fill = f;
    }
  }
  return best;
}

/** One count per step of the wall's width (styles.css: phones, then 768, 1024 and 1280 up). */
const COLS = {
  "--uv-cols-s": pickCols(SHOWN.length, 5, 6),
  "--uv-cols-m": pickCols(SHOWN.length, 5, 7),
  "--uv-cols-l": pickCols(SHOWN.length, 7, 9),
  "--uv-cols-xl": pickCols(SHOWN.length, 10, 11),
} as CSSProperties;

function Tile({ s, sel, pick, touch }: { s: Service; sel: string | null; pick: Pick; touch: boolean }) {
  return (
    <button
      type="button"
      className="uv-t"
      data-on={sel === s.id ? "" : undefined}
      aria-label={s.name}
      title={s.name}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") pick(s.id, e.currentTarget, s.name);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") pick(null);
      }}
      onFocus={(e) => pick(s.id, e.currentTarget, s.name)}
      onBlur={() => pick(null)}
      onClick={(e) => pick(touch && sel === s.id ? null : s.id, e.currentTarget, s.name)}
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
  const [ready, setReady] = useState(false);
  const [touch, setTouch] = useState(false);
  const sec = useRef<HTMLElement>(null);
  const wall = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const selEl = useRef<HTMLElement | null>(null);

  const pick: Pick = (key, el, nm) => {
    selEl.current = key ? (el ?? null) : null;
    if (nm) setName(nm);
    setSel(key);
  };

  useEffect(() => {
    setTouch(window.matchMedia("(hover: none)").matches);
    // a tap outside the wall puts the name away
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".uv-t")) pick(null);
    };
    window.addEventListener("pointerdown", away, { passive: true });
    return () => window.removeEventListener("pointerdown", away);
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
  }, []);

  return (
    <section ref={sec} id="universe" aria-label="Every service, as a wall of marks" className="uv relative">
      <div ref={wall} className="uv-wall" data-ready={ready ? "" : undefined} data-sel={sel ? "" : undefined}>
        <div className="uv-plane" style={COLS}>
          {SHOWN.map((s) => (
            <Tile key={s.id} s={s} sel={sel} pick={pick} touch={touch} />
          ))}
        </div>
      </div>
      <div ref={label} className="uv-label" aria-hidden>
        {name}
      </div>
      <noscript>
        <style>{".uv-wall{opacity:1!important}"}</style>
      </noscript>
      <p className="wrap t-small pb-16 pt-6 text-center text-ink-4 sm:pb-20">
        Logos are trademarks of their owners, shown only to say which service is meant.
      </p>
    </section>
  );
}
