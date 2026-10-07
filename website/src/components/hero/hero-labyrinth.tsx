import { type CSSProperties, useEffect, useRef } from "react";
import { Labyrinth } from "~/components/labyrinth";

/* The radial mask melts the outer rings into the page; the ember glow is
 * one CSS drop-shadow on the whole stack, one composite. */
const artStyle: CSSProperties = {
  maskImage: "radial-gradient(closest-side, black 40%, transparent 96%)",
  WebkitMaskImage: "radial-gradient(closest-side, black 40%, transparent 96%)",
  filter: "drop-shadow(0 0 12px rgba(226, 121, 90, 0.3))",
  perspective: "1600px",
};

/** How many copies of the line are stacked to raise it into walls, and how
 * far apart. Seven layers at 7px read as walls at hero size without the
 * cost of real geometry. */
const LAYERS = 7;
const STEP = 7;

/** The hero labyrinth, built: the mark's one unbroken line stacked into
 * walls and laid down as a floor plan in perspective. The top course draws
 * itself in from the center (CSS, so it runs before hydration); the courses
 * beneath rise after it. Scrolling lifts the plan toward face-on and turns
 * it a little, so the maze you looked across becomes the mark you looked
 * down at. Transform and opacity only, one rAF loop, paused while hidden;
 * reduced motion keeps the first pose and never moves. */
export function HeroLabyrinth() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let mx = 0;
    let my = 0;
    let cx = 0;
    let cy = 0;
    let cs = 0;

    const onPointer = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 2;
      my = (e.clientY / window.innerHeight - 0.5) * 2;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const target = Math.min(window.scrollY, 900);
      cx += (mx - cx) * 0.05;
      cy += (my - cy) * 0.05;
      cs += (target - cs) * 0.1;
      const p = cs / 900;
      const tilt = 56 - p * 38 + cy * 2.5;
      const spin = -18 + p * 14 + cx * 3;
      el.style.transform = `translate3d(0, ${(-cs * 0.1).toFixed(2)}px, 0) rotateX(${tilt.toFixed(2)}deg) rotateZ(${spin.toFixed(2)}deg)`;
      el.style.opacity = String(Math.max(0.35, 1 - p * 0.6));
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <div className="flex-none select-none" style={artStyle}>
      <div
        ref={ref}
        className="lab3d relative w-[46rem] will-change-transform sm:w-[62rem]"
        style={{ transformStyle: "preserve-3d", transform: "rotateX(56deg) rotateZ(-18deg)" }}
      >
        {Array.from({ length: LAYERS }, (_, i) => {
          const top = i === LAYERS - 1;
          return (
            <div
              key={i}
              className={top ? "relative" : "lab3d-course absolute inset-0"}
              style={{
                transform: `translateZ(${(i * STEP).toFixed(0)}px)`,
                opacity: top ? 0.5 : 0.05 + (i / LAYERS) * 0.13,
                animationDelay: top ? undefined : `${1.6 + i * 0.08}s`,
              }}
            >
              <Labyrinth draw={top} className="w-full" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
