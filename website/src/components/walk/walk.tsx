import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DemoWindow, type DemoView } from "~/components/demo/demo-window";
import { INGEST, NODES, type NodeId } from "./geo";
import { Mark } from "./marks";
import { INGEST_LEGAL, INGEST_NOTE, INSPECTORS, STEPS, T } from "./story";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The page, as a network you watch. One pinned stage holds a topology: the
 * box (the mark's labyrinth as its body), the machines linked to it over
 * pinned TLS, GitHub and the internet outside it. Scrolling sends three
 * requests through it, each lighting the path it really takes (story.ts),
 * and then the box takes in six services you would otherwise rent.
 *
 * Text in the graph is anchored to things in it: a caption on the node or
 * link it concerns, the real app screen popping out of the node it is about
 * and receding when the request has moved on.
 *
 * The page is complete without any of it. The prerendered HTML carries the
 * hero, a poster of the graph, and the three requests and the six services
 * as a plain list; the 3D chunk loads after first paint and only then does
 * the stage pin. Reduced motion renders one finished frame and keeps the
 * list. With no WebGL the poster stands. */

type Mode = "static" | "pinned" | "still";

const span = (f: number, a: number, b: number) => Math.min(1, Math.max(0, (f - a) / (b - a)));
const smooth = (x: number) => x * x * (3 - 2 * x);
const win = (f: number, a: number, b: number, tail = 0.02) => smooth(span(f, a, a + tail)) * (1 - smooth(span(f, b - tail, b)));

/** The scroll runs in two gears: everything up to the ingest keeps the pace it was composed at
 * (BASE svh of run for f 0..HOLD), then the eight services get the rest, so each one has room
 * to be read and drawn in. */
const BASE = 880;
const HOLD = 0.8;
const RUN = 1280;
const gear = (r: number) => {
  const a = (HOLD * BASE) / RUN;
  return r <= a ? (r / a) * HOLD : HOLD + ((r - a) / (1 - a)) * (1 - HOLD);
};

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
  const ingestCap = useRef<HTMLDivElement>(null);
  const stepEls = useRef(new Map<string, HTMLElement>());
  const nodeEls = useRef(new Map<string, HTMLElement>());
  const insEls = useRef<Array<HTMLDivElement | null>>([]);
  const tileEls = useRef<Array<HTMLElement | null>>([]);
  const modEls = useRef<Array<HTMLElement | null>>([]);
  const lineEls = useRef<Array<SVGLineElement | null>>([]);
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
    let scene: import("./net").NetScene | null = null;
    let cancelled = false;
    let raf = 0;
    let visible = true;
    let fs = 0;
    let last = performance.now();
    let booted = false;
    let lastCap = -2;

    const fit = () => scene?.resize(holder.clientWidth, holder.clientHeight);

    const place = (f: number) => {
      if (!scene) return;
      const S = scene.screen;
      const W = holder.clientWidth;
      const H = holder.clientHeight;
      // the hero copy's boxes: a label that would sit on the words steps aside
      const words: DOMRect[] = [];
      if (hero.current && f < 0.12) hero.current.querySelectorAll("p, h1, a").forEach((n) => {
          const rg = document.createRange();
          rg.selectNodeContents(n);
          words.push(rg.getBoundingClientRect());
        });
      const sh = holder.getBoundingClientRect();
      if (f > 0.05) {
        stepEls.current.forEach((el) => {
          if (Number(el.style.opacity) > 0.3) words.push(el.getBoundingClientRect());
        });
        insEls.current.forEach((el) => {
          if (el && Number(el.style.opacity) > 0.3) words.push(el.getBoundingClientRect());
        });
      }
      // node labels: quiet, always on, brighter while a request is at them
      for (const id of NODE_IDS) {
        const e = nodeEls.current.get(id);
        const a = S.get(`lab:${id}`);
        if (!e || !a) continue;
        const busy = STEPS.some((s) => "node" in s.at && s.at.node === id && f >= s.f[0] && f < s.f[1]);
        const ingest = 1 - smooth(span(f, 0.79, 0.83));
        const ew = e.offsetWidth;
        const side = NODES[id].side;
        // a label stays whole at the edge, and goes once its node has left the screen
        const lo = side === "right" ? 14 : side === "left" ? ew + 14 : ew / 2 + 14;
        const hi = side === "right" ? W - ew - 14 : side === "left" ? W - 14 : W - ew / 2 - 14;
        const cx = Math.min(hi, Math.max(lo, a.x));
        const edge = 1 - smooth(span(Math.max(lo - a.x, a.x - hi), 40, 150));
        const eh = e.offsetHeight;
        const x0 = side === "right" ? cx : side === "left" ? cx - ew : cx - ew / 2;
        const y0 = side ? a.y - eh / 2 : a.y + 28;
        const hit = words.some((r) => x0 < r.right - sh.left + 14 && x0 + ew > r.left - sh.left - 14 && y0 < r.bottom - sh.top + 10 && y0 + eh > r.top - sh.top - 10);
        const off = y0 + eh > H - 10 || y0 < 62;
        e.style.opacity = a.on && !mobile ? String(ingest * edge * (hit || off ? 0 : 1)) : "0";
        if (busy) e.setAttribute("data-busy", "");
        else e.removeAttribute("data-busy");
        e.style.transform = `translate3d(${cx.toFixed(1)}px, ${a.y.toFixed(1)}px, 0)`;
      }
      // captions: on the node or link they concern, on the side with room
      let active: (typeof STEPS)[number] | null = null;
      lineEls.current.forEach((l) => l?.setAttribute("opacity", "0"));
      for (const s of STEPS) {
        const e = stepEls.current.get(s.id);
        if (!e) continue;
        const v = win(f, s.f[0], s.f[1]);
        const key = "node" in s.at ? `top:${s.at.node}` : "link" in s.at ? `link:${s.at.link}` : "app";
        const a = S.get(key);
        if (v > 0.5) active = s;
        if (!a || !a.on || mobile) {
          e.style.opacity = "0";
          continue;
        }
        const right = a.x < W * 0.56;
        const cw = Math.min(300, W * 0.26);
        const x = right ? a.x + 44 : a.x - 44 - cw;
        const y = Math.min(H - 150, Math.max(90, "link" in s.at ? a.y + 46 : a.y - 46));
        e.style.width = `${cw}px`;
        e.style.opacity = String(v);
        e.style.textAlign = right ? "left" : "right";
        e.style.transform = `translate3d(${x.toFixed(1)}px, ${(y + (1 - v) * 10).toFixed(1)}px, 0)`;
        const ln = lineEls.current[STEPS.indexOf(s)];
        if (ln && v > 0.02) {
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
        const ww = Math.min(440, W * 0.3);
        const right = a.x < W * 0.5;
        const x = right ? W - ww - Math.max(24, W * 0.04) : Math.max(24, W * 0.04);
        const y = H - ww * 0.625 - 64;
        e.style.width = `${ww}px`;
        e.style.transformOrigin = right ? "0% 50%" : "100% 50%";
        e.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${(0.9 + 0.1 * v).toFixed(3)})`;
        const ln = lineEls.current[STEPS.length + i];
        if (ln) {
          ln.setAttribute("x1", a.x.toFixed(1));
          ln.setAttribute("y1", a.y.toFixed(1));
          ln.setAttribute("x2", (right ? x : x + ww).toFixed(1));
          ln.setAttribute("y2", (y + ww * 0.31).toFixed(1));
          ln.setAttribute("opacity", String(v * 0.5));
        }
      });
      // the ingest: each name sits at its port, then is drawn in
      const ig = span(f, ...T.ingest);
      const per = 1 / INGEST.length;
      let nowI = -1;
      INGEST.forEach((_, i) => {
        const p = (ig - i * per * 0.92) / (per * 1.3);
        const pp = Math.min(1, Math.max(0, p));
        const tile = tileEls.current[i];
        const mod = modEls.current[i];
        const port = S.get(`port:${i}`);
        const m = S.get(`module:${i}`);
        if (tile && port) {
          const inn = smooth(span(f, 0.8 + i * 0.004, 0.84));
          // at its port until the light leaves; then the mark rides the same link the light does,
          // read from the scene each frame, so the two are one motion on one clock
          const trav = smooth(span(pp, 0.4, 0.8));
          const orb = trav > 0 ? S.get(`orb:${i}`) : undefined;
          const gone = smooth(span(pp, 0.74, 0.86));
          tile.style.opacity = String(ig > 0 && pp >= 1 ? 0 : inn * (1 - gone));
          tile.style.setProperty("--d", String(1 - smooth(span(pp, 0.36, 0.5))));
          // a port near the edge is held inside the screen; the hold lets go as the mark leaves it
          const capZone = Math.abs(port.x - W / 2) < 300;
          const hx = Math.min(W - 70, Math.max(70, port.x));
          const hy = mobile ? Math.min(H - 190, Math.max(96, port.y)) : Math.min(capZone ? H - 215 : H - 90, Math.max(96, port.y));
          const tx = (orb ? orb.x : port.x) + (hx - port.x) * (1 - trav);
          const ty = (orb ? orb.y : port.y) + (hy - port.y) * (1 - trav);
          tile.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${(1 - trav * 0.5).toFixed(3)})`;
        }
        if (mod && m) {
          const lit = smooth(span(pp, 0.62, 0.86)) * (ig > 0 ? 1 : 0);
          const vis = smooth(span(f, 0.83, 0.86));
          mod.style.opacity = String(vis * (0.62 + 0.38 * lit));
          mod.style.transform = `translate3d(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px, 0)`;
          if (lit > 0.5) mod.setAttribute("data-lit", "");
          else mod.removeAttribute("data-lit");
        }
        if (nowI < 0 && ig > 0 && pp > 0 && pp < 0.88) nowI = i;
      });
      if (ingestCap.current) {
        const done = ig >= 0.97;
        const i = done ? -1 : nowI;
        ingestCap.current.style.opacity = String(f > 0.84 && (i >= 0 || done) ? 1 : 0);
        const t = ingestCap.current.querySelector("[data-t]");
        const k = ingestCap.current.querySelector("[data-k]");
        const mo = ingestCap.current.querySelector("[data-m]");
        const lg = ingestCap.current.querySelector("[data-l]");
        if (t && k && mo && lg) {
          if (i !== lastCap) {
            lastCap = i;
            for (const n of Array.from(ingestCap.current.children)) {
              n.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
            }
          }
          if (i >= 0) {
            const s = INGEST[i]!;
            k.textContent = `${s.name} · ${s.part}`;
            mo.textContent = `${s.module} · ${s.kind === "built" ? "in the catalog" : "beside the box"}`;
            t.textContent = s.made;
            lg.textContent = "";
          } else if (done) {
            k.textContent = "What the box takes in";
            mo.textContent = "";
            t.textContent = INGEST_NOTE;
            lg.textContent = INGEST_LEGAL;
          }
        }
      }
      // the hero's copy gives way to the first request
      if (hero.current) {
        const v = 1 - smooth(span(f, 0.035, 0.1));
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
      const r = section.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      const target = run > 0 ? gear(Math.min(1, Math.max(0, -r.top / run))) : 0;
      // the camera and the text ease toward the scroll, frame-rate independent,
      // so a flick and a crawl, up or down, both land without a step
      fs += (target - fs) * (1 - Math.exp(-dt * 7));
      if (Math.abs(target - fs) < 0.00004) fs = target;
      scene?.setProgress(fs);
      scene?.tick(dt);
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
          {INGEST.map((s, i) => (
            <div
              key={s.name}
              ref={(n) => {
                tileEls.current[i] = n;
              }}
              className="net-tile"
              data-kind={s.kind}
            >
              <span className="net-tile-marks">
                {s.marks.map((m) => (
                  <Mark key={m} id={m} size={20} />
                ))}
              </span>
              <strong>{s.name}</strong>
              <span className="net-tile-part">{s.part}</span>
            </div>
          ))}
          {INGEST.map((s, i) => (
            <span
              key={s.module}
              ref={(n) => {
                modEls.current[i] = n;
              }}
              className="net-module"
              data-kind={s.kind}
            >
              {s.marks.map((m) => (
                <Mark key={m} id={m} size={12} />
              ))}
              {s.module}
            </span>
          ))}
          <div ref={ingestCap} className="net-ingest-cap">
            <em data-k />
            <p>
              <b data-m />
              <span data-t />
            </p>
            <small data-l />
          </div>
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
          <h2 className="mt-20 max-w-2xl text-balance text-[clamp(1.6rem,3.4vw,2.6rem)] font-semibold leading-[1.08] tracking-[-0.03em]">
            The box takes in what you would otherwise rent.
          </h2>
          <ul className="mt-10 grid gap-x-10 border-t border-hairline sm:grid-cols-2">
            {INGEST.map((s) => (
              <li key={s.name} className="grid gap-1 border-b border-hairline py-4">
                <span className="flex items-center gap-2.5 font-mono text-[13px] text-fg">
                  {s.marks.map((m) => (
                    <Mark key={m} id={m} size={16} />
                  ))}
                  {s.name} <span className="text-muted">· {s.part}</span>
                </span>
                <span className="text-[14px] text-[#b4b4be]">
                  <b className="font-mono text-[12.5px] font-medium text-fg">{s.module}</b>
                  {" · "}
                  {s.kind === "built" ? "in the catalog" : "beside the box"}. {s.made}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-6 max-w-xl text-[13px] leading-relaxed text-dim">
            {INGEST_NOTE} {INGEST_LEGAL}
          </p>
        </div>
      </div>
    </section>
  );
}

/** What stands in for the canvas until it has drawn, and where there is no
 * GL: the graph as a drawing. Hairlines only, the box at the middle. */
function Poster() {
  const pts: Array<[number, number, string]> = [
    [500, 300, "box"],
    [150, 360, "mac"],
    [850, 370, "pc"],
    [700, 130, "pc2"],
    [210, 130, "gh"],
    [500, 520, "net"],
  ];
  return (
    <div className="net-poster" aria-hidden>
      <svg viewBox="0 0 1000 600" fill="none" preserveAspectRatio="xMidYMid slice">
        {pts.slice(1).map(([x, y]) => (
          <path
            key={`${x}${y}`}
            d={`M500 300 Q ${(500 + x) / 2} ${Math.min(300, y) - 70} ${x} ${y}`}
            stroke="var(--color-accent)"
            strokeOpacity="0.4"
            strokeWidth="1"
          />
        ))}
        {pts.map(([x, y, k]) => (
          <g key={k}>
            <ellipse cx={x} cy={y} rx={k === "box" ? 46 : 26} ry={k === "box" ? 18 : 10} stroke="#c9ccd6" strokeOpacity="0.45" />
            <rect
              x={x - (k === "box" ? 14 : 8)}
              y={y - (k === "box" ? 26 : 22)}
              width={k === "box" ? 28 : 16}
              height={k === "box" ? 22 : 18}
              stroke="#c9ccd6"
              strokeOpacity="0.7"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
