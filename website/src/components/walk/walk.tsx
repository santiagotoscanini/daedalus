import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DemoWindow, type DemoView } from "~/components/demo/demo-window";
import { NODES, type NodeId } from "./geo";
import { Mark } from "./marks";
import { INSPECTORS, STEPS } from "./story";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The page, as a network you watch. One pinned stage holds a topology: the
 * box (the mark's labyrinth as its body), the machines linked to it over
 * pinned TLS, GitHub and the internet outside it. Scrolling sends three
 * requests through it, each lighting the path it really takes (story.ts).
 *
 * Text in the graph is anchored to things in it: a caption on the node or
 * link it concerns, the real app screen popping out of the node it is about
 * and receding when the request has moved on.
 *
 * The page is complete without any of it. The prerendered HTML carries the
 * hero, a poster of the graph, and the three requests as a plain list; the 3D chunk loads after first paint and only then does
 * the stage pin. Reduced motion renders one finished frame and keeps the
 * list. With no WebGL the poster stands. */

type Mode = "static" | "pinned" | "still";

const span = (f: number, a: number, b: number) => Math.min(1, Math.max(0, (f - a) / (b - a)));
const smooth = (x: number) => x * x * (3 - 2 * x);
const win = (f: number, a: number, b: number, tail = 0.02) => smooth(span(f, a, a + tail)) * (1 - smooth(span(f, b - tail, b)));

/** The scroll runs the story to f = HOLD (the deploy has landed) over RUN svh; the scene's beats are
 * written in f, so the run maps onto 0..HOLD. */
const HOLD = 0.8;
const RUN = 704;
const gear = (r: number) => r * HOLD;

const NODE_IDS = Object.keys(NODES) as NodeId[];
const REQUESTS = ["An AI query", "A Claude session", "A push to main"].map((name) => ({
  name,
  steps: STEPS.filter((s) => s.request === name),
}));

export function Walk() {
  const sec = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hero = useRef<HTMLDivElement>(null);
  const cue = useRef<HTMLParagraphElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const cardText = useRef<HTMLParagraphElement>(null);
  const cardKick = useRef<HTMLParagraphElement>(null);
  const stepEls = useRef(new Map<string, HTMLElement>());
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const insEls = useRef<Array<HTMLDivElement | null>>([]);
  const lineEls = useRef<Array<SVGLineElement | null>>([]);
  const [mode, setMode] = useState<Mode>("pinned");
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
    let scene: import("./net").NetScene | null = null;
    let cancelled = false;
    let raf = 0;
    let visible = true;
    let fs = -1;
    let last = performance.now();
    let W = 0;
    let H = 0;
    let secTop = 0;
    let secRun = 0;
    type Box = { l: number; t: number; r: number; b: number; v: number };
    const heroWords: Box[] = [];
    const nodeSize = new Map<string, { w: number; h: number }>();
    const stepH = new Map<string, number>();
    const stepBox = new Map<string, Box>();
    const insBox = new Map<number, Box>();
    let lit = new Set<number>();
    let heroV = -1;

    /** every size the loop needs, read here (on resize, when fonts land) and never per frame */
    const measure = () => {
      W = holder.clientWidth;
      H = holder.clientHeight;
      const sr = section.getBoundingClientRect();
      secTop = sr.top + window.scrollY;
      secRun = sr.height - window.innerHeight;
      const sh = holder.getBoundingClientRect();
      nodeEls.current.forEach((e, id) => nodeSize.set(id, { w: e.offsetWidth, h: e.offsetHeight }));
      const cw = Math.min(300, W * 0.26);
      stepEls.current.forEach((e, id) => {
        e.style.width = `${cw}px`;
        stepH.set(id, e.offsetHeight);
      });
      heroWords.length = 0;
      hero.current?.querySelectorAll("p, h1, a").forEach((n) => {
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const b = rg.getBoundingClientRect();
        heroWords.push({ l: b.left - sh.left, t: b.top - sh.top, r: b.right - sh.left, b: b.bottom - sh.top, v: 1 });
      });
    };
    measure();
    if (window.scrollY > window.innerHeight * 0.35) section.setAttribute("data-deep", "");
    let booted = false;

    const fit = () => {
      measure();
      scene?.resize(W, H);
    };

    const place = (f: number) => {
      if (!scene) return;
      const S = scene.screen;
      // the boxes a label would sit on: the hero copy, and the captions and screens as last laid out
      const words: Box[] = [];
      if (f < 0.12) words.push(...heroWords);
      if (f > 0.05) {
        stepBox.forEach((b) => b.v > 0.3 && words.push(b));
        insBox.forEach((b) => b.v > 0.3 && words.push(b));
      }
      // node labels: quiet, always on, brighter while a request is at them
      for (const id of NODE_IDS) {
        const e = nodeEls.current.get(id);
        const a = S.get(`lab:${id}`);
        if (!e || !a) continue;
        const busy = STEPS.some((s) => "node" in s.at && s.at.node === id && f >= s.f[0] && f < s.f[1]);
        const sz = nodeSize.get(id);
        const ew = sz?.w ?? 0;
        const side = NODES[id].side;
        // a label stays whole at the edge, and goes once its node has left the screen
        const lo = side === "right" ? 14 : side === "left" ? ew + 14 : ew / 2 + 14;
        const hi = side === "right" ? W - ew - 14 : side === "left" ? W - 14 : W - ew / 2 - 14;
        const cx = Math.min(hi, Math.max(lo, a.x));
        const edge = 1 - smooth(span(Math.max(lo - a.x, a.x - hi), 40, 150));
        const eh = sz?.h ?? 0;
        const x0 = side === "right" ? cx : side === "left" ? cx - ew : cx - ew / 2;
        const y0 = side ? a.y - eh / 2 : a.y + 28;
        const hit = words.some((r) => x0 < r.r + 14 && x0 + ew > r.l - 14 && y0 < r.b + 10 && y0 + eh > r.t - 10);
        const off = y0 + eh > H - 10 || y0 < 62;
        e.style.opacity = a.on && !mobile ? String(edge * (hit || off ? 0 : 1)) : "0";
        if (busy) e.setAttribute("data-busy", "");
        else e.removeAttribute("data-busy");
        e.style.transform = `translate3d(${cx.toFixed(1)}px, ${a.y.toFixed(1)}px, 0)`;
      }
      // captions: on the node or link they concern, on the side with room
      let active: (typeof STEPS)[number] | null = null;
      const litNow = new Set<number>();
      for (const s of STEPS) {
        const e = stepEls.current.get(s.id);
        if (!e) continue;
        const v = win(f, s.f[0], s.f[1]);
        const key = "node" in s.at ? `top:${s.at.node}` : "link" in s.at ? `link:${s.at.link}` : "app";
        const a = S.get(key);
        if (v > 0.5) active = s;
        if (!a || !a.on || mobile) {
          if (e.style.opacity !== "0") e.style.opacity = "0";
          stepBox.delete(s.id);
          continue;
        }
        const right = a.x < W * 0.56;
        const cw = Math.min(300, W * 0.26);
        const x = right ? a.x + 44 : a.x - 44 - cw;
        const y = Math.min(H - 150, Math.max(90, "link" in s.at ? a.y + 46 : a.y - 46));
        stepBox.set(s.id, { l: x, t: y + (1 - v) * 10, r: x + cw, b: y + (1 - v) * 10 + (stepH.get(s.id) ?? 80), v });
        e.style.opacity = String(v);
        e.style.textAlign = right ? "left" : "right";
        e.style.transform = `translate3d(${x.toFixed(1)}px, ${(y + (1 - v) * 10).toFixed(1)}px, 0)`;
        const ln = lineEls.current[STEPS.indexOf(s)];
        if (ln && v > 0.02) {
          litNow.add(STEPS.indexOf(s));
          ln.setAttribute("x1", a.x.toFixed(1));
          ln.setAttribute("y1", a.y.toFixed(1));
          ln.setAttribute("x2", (right ? x - 6 : x + cw + 6).toFixed(1));
          ln.setAttribute("y2", (y + 10).toFixed(1));
          ln.setAttribute("opacity", String(v * 0.55));
        }
      }
      // the phone: one card carries the step
      if (card.current) {
        const showing = mobile && active && f < 0.82;
        card.current.style.opacity = showing ? "1" : "0";
        if (active && cardText.current && cardKick.current && cardText.current.dataset.id !== active.id) {
          cardText.current.dataset.id = active.id;
          cardText.current.textContent = active.text;
          cardKick.current.textContent = active.kicker;
        }
      }
      // inspectors: the real screens, from the node they concern
      INSPECTORS.forEach((ins, i) => {
        const e = insEls.current[i];
        if (!e) return;
        const v = mobile ? 0 : win(f, ins.f[0], ins.f[1], 0.025);
        const a = S.get(ins.from === "app" ? "app" : `node:${ins.from}`);
        e.style.opacity = String(v);
        if (!a) return;
        insBox.set(i, { l: 0, t: 0, r: 0, b: 0, v: 0 });
        const ww = Math.min(440, W * 0.3);
        const right = a.x < W * 0.5;
        const x = right ? W - ww - Math.max(24, W * 0.04) : Math.max(24, W * 0.04);
        const y = H - ww * 0.625 - 64;
        insBox.set(i, { l: x, t: y, r: x + ww, b: y + ww * 0.625, v });
        e.style.width = `${ww}px`;
        e.style.transformOrigin = right ? "0% 50%" : "100% 50%";
        e.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${(0.9 + 0.1 * v).toFixed(3)})`;
        const ln = lineEls.current[STEPS.length + i];
        if (ln && v > 0.02) {
          litNow.add(STEPS.length + i);
          ln.setAttribute("x1", a.x.toFixed(1));
          ln.setAttribute("y1", a.y.toFixed(1));
          ln.setAttribute("x2", (right ? x : x + ww).toFixed(1));
          ln.setAttribute("y2", (y + ww * 0.31).toFixed(1));
          ln.setAttribute("opacity", String(v * 0.5));
        }
      });
      lit.forEach((i) => {
        if (!litNow.has(i)) lineEls.current[i]?.setAttribute("opacity", "0");
      });
      lit = litNow;
    };

    /** the hero's copy gives way to the first request: DOM only, so it follows the scroll before the scene exists */
    const heroCue = (f: number) => {
      const v = 1 - smooth(span(f, 0.035, 0.1));
      if (hero.current && v !== heroV) {
        heroV = v;
        hero.current.style.opacity = String(v);
        hero.current.style.transform = `translate3d(0, ${(-(1 - v) * 28).toFixed(1)}px, 0)`;
        hero.current.style.pointerEvents = v > 0.6 ? "auto" : "none";
      }
      if (cue.current) cue.current.style.opacity = String(1 - smooth(span(f, 0, 0.03)));
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      // one clock: the scroll is read here (scrollY costs no layout; the section's box is cached), and the
      // camera and the text follow it with a short critically damped step, so a flick and a crawl both
      // track without lag. A jump (a reload, a back, a link) lands at once and never eases from zero.
      const target = secRun > 0 ? gear(Math.min(1, Math.max(0, (window.scrollY - secTop) / secRun))) : 0;
      if (fs < 0 || Math.abs(target - fs) > 0.1) fs = target;
      else {
        fs += (target - fs) * (1 - Math.exp(-dt * 26));
        if (Math.abs(target - fs) < 0.00004) fs = target;
      }
      heroCue(fs);
      if (!scene) return;
      scene.setProgress(fs);
      scene.tick(dt);
      place(fs);
    };

    const boot = async () => {
      if (booted) return;
      booted = true;
      try {
        const mod = await import("./net");
        if (cancelled) return;
        scene = mod.createScene({
          canvas: el,
          light: mobile,
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
        scene = null;
      }
    };

    // first paint stays light: the 3D chunk waits for the browser to be idle, or the first touch
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => number }).requestIdleCallback;
    const kick = idle ? idle(() => void boot(), { timeout: 1800 }) : window.setTimeout(() => void boot(), 900);
    const early = () => void boot();
    window.addEventListener("pointerdown", early, { once: true, passive: true });
    window.addEventListener("scroll", early, { once: true, passive: true });
    void document.fonts?.ready.then(measure);

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
    if (mode === "pinned") raf = requestAnimationFrame(frame);

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

  const views: DemoView[] = ["updates", "deploys", "apps"];

  return (
    <section
      ref={sec}
      id="walk"
      data-mode={mode}
      data-ready={ready ? "" : undefined}
      className="net relative"
      style={mode === "pinned" ? { height: `${RUN + 100}svh` } : undefined}
    >
      <div ref={stage} className="net-stage">
        <Poster />
        <canvas ref={canvas} className="net-canvas" aria-hidden />
        <div className="net-vignette" aria-hidden />

        {/* the graph's own text: anchored to things in it */}
        <div className="net-layer" aria-hidden>
          <svg className="net-lines">
            {[...STEPS, ...INSPECTORS].map((_, i) => (
              <line
                key={i}
                ref={(n) => {
                  lineEls.current[i] = n;
                }}
                opacity="0"
              />
            ))}
          </svg>
          {NODE_IDS.map((id) => (
            <span
              key={id}
              ref={(n) => {
                if (n) nodeEls.current.set(id, n);
                else nodeEls.current.delete(id);
              }}
              className="net-node"
              data-side={NODES[id].side}
            >
              <b>
                {NODES[id].mark ? <Mark id={NODES[id].mark} size={13} /> : null}
                {NODES[id].name}
              </b>
              <i>{NODES[id].state}</i>
            </span>
          ))}
          {STEPS.map((s) => (
            <p
              key={s.id}
              ref={(n) => {
                if (n) stepEls.current.set(s.id, n);
                else stepEls.current.delete(s.id);
              }}
              className="net-step"
            >
              <em>{s.kicker}</em>
              {s.text}
            </p>
          ))}
          {INSPECTORS.map((ins, i) => (
            <div
              key={ins.view}
              ref={(n) => {
                insEls.current[i] = n;
              }}
              className="net-inspector"
            >
              <DemoWindow view={views[i]!} />
            </div>
          ))}
          <div ref={card} className="net-card">
            <p ref={cardKick} />
            <p ref={cardText} />
          </div>
        </div>

        <div ref={hero} className="net-hero">
          <div className="mx-auto w-full max-w-6xl px-6">
            <div className="max-w-[46rem]">
              <p className="rise font-mono text-[11px] uppercase tracking-[0.2em] text-muted-2">
                Open source · MIT · pre-release
              </p>
              <h1 className="rise mt-5 text-[clamp(2.6rem,6.4vw,5.8rem)] font-semibold leading-[0.92] tracking-[-0.05em] sm:mt-7">
                <span className="block">Build yourself</span>
                <span className="block">a cloud.</span>
              </h1>
              <p className="rise rise-1 mt-6 max-w-[33rem] text-pretty text-[15.5px] leading-relaxed text-[#b4b4be] sm:mt-8 sm:text-[17px]">
                A control plane for the machines you own. It builds and deploys your apps, gives them
                a database and a login when they ask for one, and watches all of it. Every change it
                makes is a commit to the machine's NixOS configuration.
              </p>
              <div className="rise rise-2 mt-7 flex flex-wrap items-center gap-3 sm:mt-9">
                <a href={REPO} className="btn btn-primary h-11 px-5">
                  <Mark id="github" size={17} />
                  View on GitHub
                </a>
                <Link to="/" hash="get" className="btn btn-ghost h-11 px-5">
                  Get it
                </Link>
              </div>
            </div>
          </div>
        </div>
        <p ref={cue} className="net-cue" aria-hidden>
          <span>Scroll to send a request</span>
          <i />
        </p>
      </div>

      {/* The same story as a plain list: what the prerender, a reader without
          the canvas, and reduced motion get. The stage hides it once pinned. */}
      <div id="requests" className="net-list">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">The network at work</p>
          <h2 className="mt-3 max-w-2xl text-balance text-[clamp(1.6rem,3.4vw,2.6rem)] font-semibold leading-[1.08] tracking-[-0.03em]">
            Three requests, and the path each one really takes.
          </h2>
          <div className="mt-12 grid gap-10 md:grid-cols-3">
            {REQUESTS.map((r) => (
              <div key={r.name}>
                <h3 className="font-mono text-[12px] uppercase tracking-[0.16em] text-fg">{r.name}</h3>
                <ol className="mt-4 grid gap-4 border-t border-hairline pt-4 text-[14.5px] leading-relaxed text-[#a8a8b3]">
                  {r.steps.map((s) => (
                    <li key={s.id} className="text-pretty">
                      {s.text}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** What stands in for the canvas until it has drawn, and where there is no GL: a still of the
 * scene's own first frame (public/hero-*.png, rendered from the real scene at the hero pose with
 * nothing else on it), so the canvas fades in over the same picture and nothing changes but
 * the light. Regenerate both when the hero pose or the scene's first frame changes. */
function Poster() {
  return (
    <picture className="net-poster" aria-hidden>
      <source media="(max-width: 767px)" srcSet="/hero-tall.png" width="390" height="844" />
      <img src="/hero-wide.png" width="1440" height="900" alt="" decoding="async" fetchPriority="high" />
    </picture>
  );
}
