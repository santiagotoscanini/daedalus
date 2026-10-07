import { useEffect, useMemo, useRef } from "react";
import { byTier, COUNTS, SERVICES, type Service, TIERS, type Tier } from "~/data/services";
import { Glyph } from "./glyph";

/** The field: every name on the page as a tile in one space, and a camera that
 * starts on a few of the catalog's modules and pulls back until the whole of it
 * is in view. Nothing here is a canvas. The tiles are DOM, placed each frame by
 * one projection and one clock, so the marks stay crisp vectors, the text stays
 * text, and a browser with no GL paints the same thing.
 *
 * Where a tile stands says which tier it is in. The catalog and the services
 * beside it are one disc, laid out as a sunflower (even spacing, whatever the
 * count) with the catalog at the middle, so the camera meets it first; the
 * outside services are a ring beyond. The pull-back is the argument: what you
 * meet first is the smallest part.
 *
 * Scroll sets one number, p, and the rest follows from it: the dolly out, the
 * tilt up toward plan, the yaw, which tier is lit. The camera eases toward p
 * (frame-rate independent), so a flick and a crawl both land without a step. */

const GOLDEN = 2.399963229728653;
const CENTER_GAP = 4;

interface Placed {
  s: Service;
  /** world, y up */
  x: number;
  y: number;
  z: number;
}

function layout(list: Service[], ringBase: number) {
  const disc = list.filter((s) => s.tier !== "connects");
  const ring = list.filter((s) => s.tier === "connects");
  const out: Placed[] = [];
  disc.forEach((s, i) => {
    const r = Math.sqrt(i + CENTER_GAP);
    const a = i * GOLDEN;
    out.push({ s, x: Math.cos(a) * r, z: Math.sin(a) * r, y: 0.035 * r * r });
  });
  const rOut = Math.sqrt(disc.length + CENTER_GAP) + 1.9;
  // the ring is two arcs, one each side of the middle, so the pull-back ends with them where the
  // screen has room; the sway of the yaw keeps them there
  const right = Math.ceil(ring.length / 2);
  ring.forEach((s, i) => {
    const onRight = i < right;
    const n = onRight ? right : ring.length - right;
    const k = onRight ? i : i - right;
    const a = ringBase + (onRight ? 0 : Math.PI) + (n > 1 ? (k / (n - 1) - 0.5) * 1.25 : 0);
    out.push({ s, x: Math.cos(a) * rOut, z: Math.sin(a) * rOut, y: 0.035 * rOut * rOut + (i % 2 ? 0.5 : -0.2) });
  });
  const edge = (t: Tier) => {
    const rs = out.filter((p) => p.s.tier === t).map((p) => Math.hypot(p.x, p.z));
    return { lo: Math.min(...rs), hi: Math.max(...rs) };
  };
  const cat = edge("catalog");
  const bes = edge("beside");
  return {
    placed: out,
    rOut,
    /** the boundaries drawn as faint orbits: between catalog and beside, and the ring */
    rings: [(cat.hi + bes.lo) / 2 + 0.15, rOut],
  };
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const span = (f: number, a: number, b: number) => clamp((f - a) / (b - a));
const smooth = (x: number) => x * x * (3 - 2 * x);
const inOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** where each tier is lit, in p */
const BEATS: Array<{ tier: Tier | "all"; a: number; b: number }> = [
  { tier: "catalog", a: 0, b: 0.36 },
  { tier: "beside", a: 0.36, b: 0.7 },
  { tier: "connects", a: 0.7, b: 0.9 },
  { tier: "all", a: 0.9, b: 1.0001 },
];

export function Field() {
  const stage = useRef<HTMLDivElement>(null);
  const tileEls = useRef<Array<HTMLDivElement | null>>([]);
  const boxEls = useRef<Array<HTMLSpanElement | null>>([]);
  const nameEls = useRef<Array<HTMLSpanElement | null>>([]);
  const spokeEls = useRef<Array<SVGLineElement | null>>([]);
  const orbitEls = useRef<Array<SVGPathElement | null>>([]);
  const centerEl = useRef<HTMLDivElement>(null);
  const headEl = useRef<HTMLDivElement>(null);
  const legendBox = useRef<HTMLDivElement>(null);
  const proj = useRef<Array<{ sx: number; sy: number; px: number; w: number; ratio: number }>>([]);
  const keepouts = useRef<Array<{ l: number; t: number; r: number; b: number }>>([]);
  const beatEls = useRef<Array<HTMLDivElement | null>>([]);
  const legendEls = useRef<Array<HTMLSpanElement | null>>([]);
  const mobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const list = useMemo(() => (mobile ? SERVICES.filter((s) => s.lead) : SERVICES), [mobile]);
  const world = useMemo(() => layout(list, mobile ? Math.PI / 2 : 0), [list, mobile]);

  useEffect(() => {
    const holder = stage.current;
    const section = holder?.parentElement;
    if (!holder || !section) return;
    const { placed, rOut, rings } = world;
    let W = holder.clientWidth;
    let H = holder.clientHeight;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    let t = 0;
    let fs = -1;
    let lastBeat = -1;

    const size = () => {
      W = holder.clientWidth;
      H = holder.clientHeight;
      const o = holder.getBoundingClientRect();
      const k: typeof keepouts.current = [];
      const hr = headEl.current?.getBoundingClientRect();
      if (hr) k.push({ l: hr.left - o.left - 10, t: hr.top - o.top - 10, r: hr.right - o.left + 10, b: hr.bottom - o.top + 6 });
      const lr = legendBox.current?.getBoundingClientRect();
      if (lr) k.push({ l: 0, t: lr.top - o.top - 10, r: W, b: H });
      keepouts.current = k;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(holder);
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
    });
    io.observe(holder);

    const RATIO = mobile ? 2.1 : 2.5;
    const BOX = 64;
    const lo = mobile ? 34 : 30;
    const hi = mobile ? 62 : 90;
    const cap = (px: number) => clamp(px, lo, hi);

    const draw = (p: number) => {
      // the camera: out along its axis, up toward plan, round the middle
      const ez = inOut(p);
      const D1 = 30;
      const D0 = D1 / RATIO;
      const D = D0 * (D1 / D0) ** ez;
      // the pull ends with everything in; a phone ends with the field larger than the screen
      const fitHalf = mobile ? 0.74 * W : 0.45 * W;
      const F = (fitHalf / (rOut + 1.3)) * D1;
      const el = 0.56 + 0.5 * ez;
      // the camera comes round to face the field, then sways a little round that
      const yaw = (p - 1) * 1.5 + Math.sin(t * 0.13) * 0.22;
      const ca = Math.cos(yaw);
      const sa = Math.sin(yaw);
      const ce = Math.cos(el);
      const se = Math.sin(el);
      const cx = W / 2;
      const cy = H * (mobile ? 0.56 : 0.55) + (1 - ez) * H * 0.02;

      const tierLit = (tier: Tier) => {
        const b = BEATS.findIndex((x) => p >= x.a && p < x.b);
        const cur = BEATS[b < 0 ? BEATS.length - 1 : b]!;
        return cur.tier === "all" || cur.tier === tier ? 1 : 0.42;
      };
      const appear = {
        catalog: 1,
        beside: smooth(span(p, 0.1, 0.34)),
        connects: smooth(span(p, 0.52, 0.78)),
      } satisfies Record<Tier, number>;

      // pass one: where each tile is, how large, how deep
      const P = proj.current;
      placed.forEach((pl, i) => {
        const x = pl.x * ca - pl.z * sa;
        const z = pl.x * sa + pl.z * ca;
        const u = pl.y * ce - z * se;
        const w = pl.y * se + z * ce;
        const den = Math.max(D - w, 0.35 * D);
        const s = F / den;
        const px = cap(s * 0.92);
        const q = (P[i] ??= { sx: 0, sy: 0, px: 0, w: 0, ratio: 1 });
        q.sx = cx + x * s;
        q.sy = cy - u * s;
        q.px = px;
        q.w = w;
        q.ratio = D / den;
      });

      // pass two: what shows. Text zones keep their ground, and a name gives way to a tile in front of it.
      const keep = keepouts.current;
      placed.forEach((pl, i) => {
        const tile = tileEls.current[i];
        const box = boxEls.current[i];
        const name = nameEls.current[i];
        const q = P[i];
        if (!tile || !box || !name || !q) return;
        const { sx, sy, px, w, ratio } = q;
        const depth = clamp(0.4 + 0.6 * ratio ** 1.6);
        const onscreen = sx > -90 && sx < W + 90 && sy > -90 && sy < H + 90;
        let clear = 1;
        for (const r of keep) {
          const dx = Math.max(r.l - (sx + px / 2), sx - px / 2 - r.r, 0);
          const dy = Math.max(r.t - (sy + px / 2 + 16), sy - px / 2 - r.b, 0);
          clear = Math.min(clear, smooth(span(Math.hypot(dx, dy), 0, 46)));
        }
        const a = onscreen ? depth * appear[pl.s.tier] * tierLit(pl.s.tier) * clear : 0;
        tile.style.opacity = a < 0.01 ? "0" : a.toFixed(3);
        if (a < 0.01) return;
        tile.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
        tile.style.zIndex = String(Math.round(1000 + w * 40));
        box.style.scale = (px / BOX).toFixed(3);
        name.style.translate = `-50% ${(px / 2 + 7).toFixed(1)}px`;
        // the name shows while it can be read: the tile is large enough, it is near, and nothing nearer stands on it
        const nw = pl.s.name.length * 6.5 + 4;
        const n0 = sx - nw / 2;
        const n1 = sx + nw / 2;
        const ny0 = sy + px / 2 + 5;
        const ny1 = ny0 + 13;
        let covered = false;
        for (let j = 0; j < placed.length && !covered; j++) {
          const o = P[j];
          if (!o || j === i || o.w <= w) continue;
          const ox = Math.min(n1, o.sx + o.px / 2) - Math.max(n0, o.sx - o.px / 2);
          covered = ox > nw * 0.4 && ny0 < o.sy + o.px / 2 && ny1 > o.sy - o.px / 2;
        }
        name.style.opacity = px >= 40 && ratio > 0.8 && !covered ? "1" : "0";
        if (pl.s.tier === "connects") {
          const sp = spokeEls.current[i - (placed.length - spokeEls.current.length)];
          if (sp) {
            sp.setAttribute("x1", cx.toFixed(1));
            sp.setAttribute("y1", cy.toFixed(1));
            sp.setAttribute("x2", sx.toFixed(1));
            sp.setAttribute("y2", sy.toFixed(1));
            sp.setAttribute("opacity", (0.34 * a).toFixed(3));
          }
        }
      });

      // the orbits: the ring and the catalog's edge, as the field sees them
      rings.forEach((r, i) => {
        const el2 = orbitEls.current[i];
        if (!el2) return;
        const hy = 0.035 * r * r;
        let d = "";
        for (let n = 0; n <= 96; n++) {
          const a = (n / 96) * Math.PI * 2;
          const x = Math.cos(a) * r * ca - Math.sin(a) * r * sa;
          const z = Math.cos(a) * r * sa + Math.sin(a) * r * ca;
          const u = hy * ce - z * se;
          const w = hy * se + z * ce;
          const s = F / Math.max(D - w, 0.35 * D);
          d += `${n ? "L" : "M"}${(cx + x * s).toFixed(1)} ${(cy - u * s).toFixed(1)}`;
        }
        el2.setAttribute("d", d);
        el2.style.opacity = String(i === 0 ? 0.5 * appear.beside : 0.7 * appear.connects);
      });

      // the box at the middle
      if (centerEl.current) {
        const s = F / D;
        const px = clamp(s * 1.5, 40, 110);
        centerEl.current.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0) scale(${(px / 64).toFixed(3)})`;
      }

      // the caption for the beat, and which tier the legend lights
      const b = BEATS.findIndex((x) => p >= x.a && p < x.b);
      const bi = b < 0 ? BEATS.length - 1 : b;
      BEATS.forEach((_, i) => {
        const e = beatEls.current[i];
        if (!e) return;
        const v = i === bi ? 1 : 0;
        e.style.opacity = String(v);
        e.style.transform = `translate3d(0, ${v ? 0 : 6}px, 0)`;
      });
      if (bi !== lastBeat) {
        lastBeat = bi;
        legendEls.current.forEach((e, i) => {
          if (!e) return;
          const tier = (["catalog", "beside", "connects"] as const)[i]!;
          const on = BEATS[bi]!.tier === "all" || BEATS[bi]!.tier === tier;
          if (on) e.setAttribute("data-on", "");
          else e.removeAttribute("data-on");
        });
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      t += dt;
      const r = section.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      const target = run > 0 ? clamp(-r.top / run) : 0;
      if (fs < 0) fs = target;
      fs += (target - fs) * (1 - Math.exp(-dt * 6));
      if (Math.abs(target - fs) < 0.00005) fs = target;
      draw(fs);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [world, mobile]);

  const ringN = world.placed.filter((p) => p.s.tier === "connects").length;
  const tiersShown = (["catalog", "beside", "connects"] as const).map((t) => ({
    t,
    n: t === "catalog" ? COUNTS.catalogModules : byTier(t).length,
  }));

  return (
    <div ref={stage} className="uv-stage" aria-hidden>
      <div className="uv-vignette" />
      <svg className="uv-lines">
        {world.rings.map((_, i) => (
          <path
            key={i}
            ref={(n) => {
              orbitEls.current[i] = n;
            }}
            data-ring={i}
            fill="none"
          />
        ))}
        {Array.from({ length: ringN }, (_, i) => (
          <line
            key={i}
            ref={(n) => {
              spokeEls.current[i] = n;
            }}
            opacity="0"
          />
        ))}
      </svg>
      <div className="uv-layer">
        <div ref={centerEl} className="uv-center">
          <span className="uv-center-box">
            <Glyph s={{ id: "box", name: "the box", tier: "catalog", mark: "daedalus" }} size={34} />
          </span>
        </div>
        {world.placed.map((pl, i) => (
          <div
            key={pl.s.id}
            ref={(n) => {
              tileEls.current[i] = n;
            }}
            className="uv-tile"
            data-tier={pl.s.tier}
          >
            <span
              ref={(n) => {
                boxEls.current[i] = n;
              }}
              className="uv-box"
            >
              <Glyph s={pl.s} size={28} />
            </span>
            <span
              ref={(n) => {
                nameEls.current[i] = n;
              }}
              className="uv-name"
            >
              {pl.s.name}
            </span>
          </div>
        ))}
      </div>

      <div ref={headEl} className="uv-head">
        <p className="uv-kicker">What is in it</p>
        <p className="uv-title">Everything it touches.</p>
        <div className="uv-beats">
          {BEATS.map((b, i) => (
            <div
              key={b.tier}
              ref={(n) => {
                beatEls.current[i] = n;
              }}
              className="uv-beat"
            >
              {b.tier === "all" ? (
                <p>
                  {COUNTS.total} names in three tiers. The catalog is the part a host can switch on today; the
                  rest is what a Daedalus box already runs, and what it reaches.
                  {mobile ? " This is a selection; wider screens show every one." : ""}
                </p>
              ) : (
                <p>{TIERS[b.tier].line}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div ref={legendBox} className="uv-legend">
        {tiersShown.map(({ t, n }, i) => (
          <span
            key={t}
            ref={(e) => {
              legendEls.current[i] = e;
            }}
            className="uv-key"
            data-tier={t}
          >
            <i />
            {TIERS[t].label}
            <b>{t === "catalog" ? `${n} modules` : n}</b>
          </span>
        ))}
      </div>
      <p className="uv-legal">Logos are trademarks of their owners, shown only to say which service is meant.</p>
    </div>
  );
}
