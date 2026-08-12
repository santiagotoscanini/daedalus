import { type CSSProperties, useEffect, useRef } from "react";
import { Labyrinth } from "~/components/labyrinth";

/* The radial mask melts the spiral's outer rings into the page; the ember
 * glow is a single cheap CSS drop-shadow on the whole SVG — one composite,
 * not one per segment. (Inline styles: neither is a Tailwind core utility.) */
const artStyle: CSSProperties = {
  maskImage: "radial-gradient(closest-side, black 45%, transparent 98%)",
  WebkitMaskImage: "radial-gradient(closest-side, black 45%, transparent 98%)",
  filter: "drop-shadow(0 0 14px rgba(226, 121, 90, 0.35))",
};

/** The hero labyrinth, given life: a slow scroll parallax (the line recedes
 * at ~0.12x scroll speed and dims as you leave the hero) and a faint pointer
 * drift (±12px, critically damped). Transform/opacity only, one rAF loop,
 * paused while the tab is hidden, disabled under reduced motion — the drawn
 * line is the experience, this is just breath. */
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
    let cs = 0; // eased scroll offset

    const onPointer = (e: PointerEvent) => {
      mx = (e.clientX / window.innerWidth - 0.5) * 24;
      my = (e.clientY / window.innerHeight - 0.5) * 12;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const target = Math.min(window.scrollY, 1200);
      cx += (mx - cx) * 0.06;
      cy += (my - cy) * 0.06;
      cs += (target - cs) * 0.12;
      el.style.transform = `translate3d(${cx.toFixed(2)}px, ${(cy - cs * 0.12).toFixed(2)}px, 0)`;
      el.style.opacity = String(Math.max(0.4, 1 - cs / 1400));
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
    };
  }, []);

  return (
    <div ref={ref} className="flex-none select-none will-change-transform" style={artStyle}>
      <Labyrinth draw className="w-[52rem] max-w-none opacity-[0.34] sm:w-[70rem]" />
    </div>
  );
}
