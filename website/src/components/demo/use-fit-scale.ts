import { type RefObject, useEffect, useLayoutEffect } from "react";

/** The demo windows are authored on a fixed desktop canvas and scaled to
 * fit their container (container queries + a ResizeObserver refinement),
 * so every label keeps real UI density at any viewport. */
export const DESIGN_W = 1280;
export const DESIGN_H = 800;

// useLayoutEffect warns during SSR; both are no-ops there, so alias.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useFitScale(ref: RefObject<HTMLElement | null>) {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      el.style.setProperty("--demo-scale", String(el.clientWidth / DESIGN_W));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
