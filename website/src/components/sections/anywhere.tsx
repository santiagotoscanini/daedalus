import { useEffect, useRef, useState } from "react";
import { Logo } from "~/components/logo";
import { SectionHeading } from "~/components/ui/section-heading";

/** Where it is going: the same app, with the same building blocks, in the house or in the cloud.
 * The card moves between the two and nothing on it changes, which is the point; the note says
 * plainly that today the move has been made once, by hand. It makes the trip once by itself when
 * it first comes into view. */

const BLOCKS = ["Sign-in", "Models", "Waitlist", "Invite codes", "Queues", "Notifications"];

type Place = "home" | "cloud";

export function Anywhere() {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Place>("home");

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let t = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        t = window.setTimeout(() => setAt("cloud"), 1100);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  return (
    <section id="anywhere" aria-labelledby="anywhere-title" className="cell scroll-mt-16 px-6 py-24 sm:px-12 sm:py-32">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
        <div>
          <SectionHeading
            id="anywhere-title"
            label="Where it’s going"
            title="Nobody should care where their software runs."
            sub="Some of it will outgrow the house: the box goes down, a model won’t fit, strangers need to trust what they open. Then it should move to the cloud in one step, with nothing rewritten. That works only if the building blocks behave the same in both places."
          />
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => setAt((p) => (p === "home" ? "cloud" : "home"))} className="btn btn-ghost btn-sm">
              {at === "home" ? "Move it to the cloud" : "Bring it home"}
            </button>
            <span className="text-[13px] text-muted-2">Today this move has been made once, by hand.</span>
          </div>
        </div>

        <div ref={ref} className="grid gap-3 sm:grid-cols-2" aria-live="polite">
          {(["home", "cloud"] as const).map((p) => (
            <div key={p} className="flex min-h-[13rem] flex-col rounded-xl border border-dashed border-line-2 p-3 sm:min-h-[19rem]">
              <p className="label px-1 pb-3">{p === "home" ? "Your box" : "The cloud"}</p>
              <div className="grid flex-1 place-items-center">
                {at === p ? (
                  <div className="w-full rounded-lg border border-line-2 bg-surface p-4 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.9)] [animation:rise_0.5s_cubic-bezier(0.21,0.47,0.32,0.98)_both]">
                    <p className="flex items-center gap-2 text-[14px] font-medium">
                      <Logo size={16} />
                      almacen
                      <span className="ml-auto flex items-center gap-1.5 text-[11.5px] font-normal text-status-ok">
                        <span className="size-1.5 rounded-full bg-status-ok" aria-hidden />
                        Running
                      </span>
                    </p>
                    <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {BLOCKS.map((b) => (
                        <li key={b} className="flex items-center gap-1.5 text-[12px] text-muted">
                          <span className="text-status-ok" aria-hidden>
                            ✓
                          </span>
                          {b}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-2">{p === "home" ? "in the house" : "a platform, a lab or a data provider"}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
