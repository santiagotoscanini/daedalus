import { type ComponentType, useEffect, useRef, useState } from "react";
import { byTier, COUNTS, type Service, TIERS, type Tier } from "~/data/services";

/** What the field is made of, and the one place its mode is chosen.
 *
 * The page is complete without the field: the prerender, a reader with no
 * script, and reduced motion get the roster, the same three tiers as plain
 * tiles with names. Once hydrated and not reduced, the field mounts: one
 * pinned stage in which the camera starts on a few of the catalog's modules
 * and pulls back through everything else (field.tsx). The marks live in the
 * lazy chunk, so the first paint carries names only. */

export type Glyph = ComponentType<{ s: Service; size?: number }>;
type Mode = "static" | "pinned";

const TIER_ORDER: Tier[] = ["catalog", "beside", "connects"];
/** svh of scroll the pull-back takes, beyond the stage itself */
export const RUN = 340;

export function Universe() {
  const [mode, setMode] = useState<Mode>("static");
  const [Field, setField] = useState<ComponentType | null>(null);
  const [Glyph, setGlyph] = useState<Glyph | null>(null);
  const sec = useRef<HTMLElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancelled = false;
    import("./lazy").then((m) => {
      if (cancelled) return;
      setGlyph(() => m.Glyph);
      if (!reduced) {
        setField(() => m.Field);
        setMode("pinned");
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section
      ref={sec}
      id="universe"
      data-mode={mode}
      aria-labelledby="universe-title"
      className="uv relative"
      style={mode === "pinned" ? { height: `${RUN + 100}svh` } : undefined}
    >
      {mode === "pinned" && Field ? <Field /> : null}
      <Roster Glyph={Glyph} hidden={mode === "pinned"} />
    </section>
  );
}

/** The three tiers as tiles. Visible as the page's own section for the
 * static and reduced-motion cases; screen-reader-only while the field runs,
 * so the content is there once. */
function Roster({ Glyph, hidden }: { Glyph: Glyph | null; hidden: boolean }) {
  return (
    <div className={hidden ? "sr-only" : "mx-auto max-w-6xl px-6 py-24 sm:py-32"}>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">What is in it</p>
      <h2
        id="universe-title"
        className="mt-3 max-w-2xl text-balance text-[clamp(1.8rem,4vw,3rem)] font-semibold leading-[1.06] tracking-[-0.035em]"
      >
        Everything it touches.
      </h2>
      <p className="mt-4 max-w-xl text-pretty text-[15px] leading-relaxed text-muted">
        {COUNTS.total} names in three tiers. The catalog is the part a host can switch on today; the rest is what
        a Daedalus box already runs, and what it reaches.
      </p>
      <div className="mt-14 grid gap-14">
        {TIER_ORDER.map((t) => (
          <div key={t}>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-hairline pb-3">
              <h3 className="font-mono text-[12px] uppercase tracking-[0.16em] text-fg">{TIERS[t].label}</h3>
              <span className="font-mono text-[12px] text-muted">
                {t === "catalog" ? `${COUNTS.catalogModules} modules` : byTier(t).length}
              </span>
            </div>
            <p className="mt-3 max-w-2xl text-pretty text-[13.5px] leading-relaxed text-muted">{TIERS[t].line}</p>
            <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {byTier(t).map((s) => (
                <li key={s.id} className="flex items-center gap-3 text-[13.5px] text-[#d4d4db]">
                  <span className="uv-chip" data-tier={t}>
                    {Glyph ? <Glyph s={s} size={20} /> : <span className="uv-mono">{s.mono ?? s.name.slice(0, 2)}</span>}
                  </span>
                  <span className="min-w-0 truncate">{s.name}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-12 max-w-xl text-[12.5px] leading-relaxed text-dim">
        Logos are trademarks of their owners, shown only to say which service is meant.
      </p>
    </div>
  );
}
