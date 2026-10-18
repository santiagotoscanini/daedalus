import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { APP, AppTile } from "~/components/demo/chrome";
import { tabKeyTarget } from "~/components/sections/agent-install";

/** Where it is going: one app's card, with a switch between the house and the cloud. Only the
 * "Runs on" row changes; the address, the sign-in, the database and the models stay as they are,
 * which is the claim. Its value is set like the others, so the cross-fade and the row's one wash are
 * all that mark the move. The switch flips by itself once, a second after the card is 60% in view,
 * unless the reader has touched it first or prefers reduced motion. Prerender and no-script show
 * the house. The note says the move has been made once, by hand. */

type Place = "house" | "cloud";

const PLACES: Array<{ id: Place; label: string; runsOn: string }> = [
  { id: "house", label: "In the house", runsOn: "The box, in the house" },
  { id: "cloud", label: "In the cloud", runsOn: "A cloud platform" },
];

/** The rows the move leaves alone. */
const SAME: Array<{ label: string; value: string; mono?: boolean }> = [
  { label: "Address", value: "almacen.toscanini.me", mono: true },
  { label: "Sign-in", value: "Passkeys" },
  { label: "Database", value: "Postgres" },
  { label: "Models", value: "One gateway key" },
];

/** Product type, set inline: arbitrary `text-[Npx]` classes belong to components/demo/ alone. */
const txt = (size: number, lineHeight: number, weight: number, color: string): CSSProperties => ({
  fontSize: size,
  lineHeight: `${lineHeight}px`,
  fontWeight: weight,
  color,
});

const ROW = "grid h-11 grid-cols-[96px_minmax(0,1fr)] items-center border-t px-5 sm:grid-cols-[120px_minmax(0,1fr)]";

/** The hero row's `wash` keyframe and duration (styles.css), from a brighter tint than the hero's
 * because here one row has to carry the whole move. The delay holds the tint through the
 * cross-fade, then it fades. */
const WASH = {
  "--wash": "rgba(255,255,255,.10)",
  animation: "wash var(--d-wash) var(--ease-out) 240ms both",
} as CSSProperties;

export function Anywhere() {
  const [at, setAt] = useState<Place>("house");
  /** Counts moves, to key the wash so each one replays it; zero means none yet, so no wash. */
  const [moves, setMoves] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const tabs = useRef<Record<Place, HTMLButtonElement | null>>({ house: null, cloud: null });
  const stopAuto = useRef<() => void>(() => {});
  const baseId = useId();

  useEffect(() => {
    const el = card.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    // isIntersecting turns true at the first visible pixel, so the ratio is what is checked
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e || e.intersectionRatio < 0.6) return;
        io.disconnect();
        timer = window.setTimeout(() => {
          setAt("cloud");
          setMoves((n) => n + 1);
        }, 1000);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    stopAuto.current = () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
    return stopAuto.current;
  }, []);

  const choose = (to: Place, focus = false) => {
    stopAuto.current();
    if (focus) tabs.current[to]?.focus();
    if (to === at) return;
    setAt(to);
    setMoves((n) => n + 1);
  };

  /** The same keys as the agent's OS switch in the close. */
  const onTabKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabKeyTarget(e.key, i, PLACES.length);
    if (next === null) return;
    e.preventDefault();
    choose(PLACES[next]!.id, true);
  };

  const current = PLACES.find((p) => p.id === at)!;

  return (
    <section id="anywhere" aria-labelledby="anywhere-title" className="pb-18 pt-10 sm:pb-24 sm:pt-12 lg:pb-28 lg:pt-16">
      <div className="wrap text-center">
        <h2 id="anywhere-title" className="t-display mx-auto max-w-[720px]">
          Nobody should care where their software runs.
        </h2>
        <p className="t-lead mx-auto mt-4 max-w-[560px]">
          Some of it will outgrow the house: a model won’t fit, or strangers need to trust what they open. Then it
          should move to the cloud in one step, with nothing rewritten.
        </p>

        <div className="mt-10 flex justify-center">
          <div role="tablist" aria-label="Where almacen runs" className="seg">
            {PLACES.map((p, i) => {
              const active = p.id === at;
              return (
                <button
                  key={p.id}
                  ref={(el) => {
                    tabs.current[p.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${baseId}-tab-${p.id}`}
                  aria-selected={active}
                  aria-controls={`${baseId}-card`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => choose(p.id)}
                  onKeyDown={onTabKey(i)}
                  className="seg-item hover:text-ink-1"
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          ref={card}
          id={`${baseId}-card`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${at}`}
          tabIndex={0}
          data-product=""
          className="fragment mx-auto mt-6 max-w-[588px] text-left"
        >
          <div className="flex h-14 items-center gap-3 px-5">
            <AppTile name="almacen" size={28} />
            <div className="min-w-0">
              <p style={txt(14, 20, 600, APP.text)}>almacen</p>
              <p className="truncate" style={txt(12, 16, 400, APP.subdued)}>
                The store’s hours, for mom
              </p>
            </div>
            <p className="ml-auto flex shrink-0 items-center gap-1.5" style={txt(12, 16, 400, APP.subdued)}>
              <span className="size-1.5 rounded-full" style={{ background: APP.ok }} aria-hidden />
              Running
            </p>
          </div>

          <dl>
            <div className={`${ROW} relative isolate`} style={{ borderColor: APP.hairline }}>
              {moves > 0 ? (
                <span key={moves} aria-hidden className="absolute inset-0 -z-10 motion-reduce:hidden" style={WASH} />
              ) : null}
              <dt style={txt(12, 16, 400, APP.subdued)}>Runs on</dt>
              <dd aria-live="polite" style={txt(13, 20, 400, APP.text)}>
                <span className="sr-only">{current.runsOn}</span>
                <span aria-hidden className="inline-grid">
                  {PLACES.map((p) => (
                    <span
                      key={p.id}
                      className={`col-start-1 row-start-1 transition-opacity motion-reduce:transition-none ${
                        p.id === at ? "opacity-100 duration-(--d-2) ease-out" : "opacity-0 duration-[160ms] ease-ui"
                      }`}
                    >
                      {p.runsOn}
                    </span>
                  ))}
                </span>
              </dd>
            </div>
            {SAME.map((r) => (
              <div key={r.label} className={ROW} style={{ borderColor: APP.hairline }}>
                <dt style={txt(12, 16, 400, APP.subdued)}>{r.label}</dt>
                <dd className={r.mono ? "truncate font-mono" : "truncate"} style={txt(r.mono ? 12 : 13, 20, 400, APP.text)}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="t-small mt-4 text-ink-4">Today this move has been made once, by hand.</p>
      </div>
    </section>
  );
}
