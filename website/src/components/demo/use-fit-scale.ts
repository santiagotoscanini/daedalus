import { type RefObject, useEffect, useLayoutEffect } from "react";

/** The hero's canvas is authored at a fixed 1280×800 and zoomed to its frame, so every label keeps
 * the product's real density: 1:1 at 1440, 0.775 at 1024, never above 1. This writes
 * `--demo-scale = min(1, width / 1280)` on the element it measures (`.hero-shot`, exactly as wide as
 * the frame, which is display:none below 1024 and so cannot be measured itself). styles.css carries
 * a CSS default for the same value, so the canvas is sized before script runs and without it. */
export const DESIGN_W = 1280;

// useLayoutEffect warns during SSR; both are no-ops there, so alias.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useFitScale(ref: RefObject<HTMLElement | null>) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.setProperty("--demo-scale", String(Math.min(1, el.clientWidth / DESIGN_W)));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
