import { type ReactNode, useEffect, useRef, useState } from "react";
import { SectionHeading } from "~/components/ui/section-heading";

/** How it works: one request, five steps, each with the screen it produces.
 *
 * Every step is what the reference box does today when its owner asks from a phone: a coding agent
 * on one of the machines does the work and asks before it guesses; the change lands as a commit to
 * the files that describe the machine (the registry entry is the real shape of site/apps.json); a
 * push wakes the box, which builds with Railpack, runs the repo's checks, keeps the image in its
 * own registry and starts it (BUILDS.md); the app gets its address, certificate, sign-in and
 * database from the platform; and taking it back is one more commit. The older history lines are
 * real commits on that box, in plain words.
 *
 * The tabs advance by themselves while the section is on screen, and stop for good once a reader
 * picks one. Every panel is in the prerendered HTML. */

interface Step {
  id: string;
  title: string;
  text: string;
  panel: () => ReactNode;
}

const STEPS: Step[] = [
  {
    id: "ask",
    title: "Say what you need",
    text: "From your phone, wherever you are. A coding agent on one of your machines takes it from there, and asks before it guesses.",
    panel: () => <AskPanel />,
  },
  {
    id: "write",
    title: "It is written down",
    text: "The whole machine is described in files. Your request becomes a commit to them, with a message that says what changed and why.",
    panel: () => <WritePanel />,
  },
  {
    id: "build",
    title: "The box builds it",
    text: "A push wakes the box. It builds the image itself, runs the repository’s checks and keeps the result in its own registry. Nothing leaves the house.",
    panel: () => <BuildPanel />,
  },
  {
    id: "ship",
    title: "It ships with everything",
    text: "An address, a certificate, a sign-in and a database, without asking. You see it on the phone you asked from.",
    panel: () => <ShipPanel />,
  },
  {
    id: "undo",
    title: "One step takes it back",
    text: "Every change is a commit. If it isn’t right, the machine returns to the one before, and the history keeps both.",
    panel: () => <UndoPanel />,
  },
];

const DWELL = 6200;

export function How() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const [cycle, setCycle] = useState(0);

  // advance on a clock while the section is on screen, until someone picks a step
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(([e]) => setAuto(!!e?.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => {
      setActive((a) => (a + 1) % STEPS.length);
      setCycle((c) => c + 1);
    }, DWELL);
    return () => window.clearTimeout(t);
  }, [auto, active, cycle]);

  const pick = (i: number) => {
    setActive(i);
    setAuto(false);
    setCycle((c) => c + 1);
  };

  return (
    <section id="how" aria-labelledby="how-title" className="cell scroll-mt-16 px-6 py-24 sm:px-12 sm:py-32">
      <SectionHeading
        id="how-title"
        label="How it works"
        title={
          <>
            A computer you talk to. <span className="text-muted">Nobody should have to administer it.</span>
          </>
        }
      />

      <div ref={ref} className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.4fr)] lg:gap-12">
        <ol className="flex flex-col" role="tablist" aria-label="The steps of one request">
          {STEPS.map((s, i) => {
            const on = i === active;
            return (
              <li key={s.id} className="relative border-l border-line">
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-controls={`how-panel-${s.id}`}
                  onClick={() => pick(i)}
                  className={`block w-full py-4 pl-5 pr-2 text-left transition-colors ${on ? "" : "hover:bg-white/[0.02]"}`}
                >
                  <span className={`flex items-baseline gap-3 text-[15px] font-medium ${on ? "text-fg" : "text-muted"}`}>
                    <span className="font-mono text-[11.5px] text-muted-2">{String(i + 1).padStart(2, "0")}</span>
                    {s.title}
                  </span>
                  <span
                    className={`grid transition-all duration-500 ${on ? "mt-2 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
                  >
                    <span className="overflow-hidden pl-[1.95rem] text-[14px] leading-relaxed text-muted">{s.text}</span>
                  </span>
                </button>
                {on ? (
                  <span
                    key={`${cycle}`}
                    className="absolute -left-px top-0 w-px bg-fg"
                    style={{
                      height: "100%",
                      transformOrigin: "top",
                      animation: auto ? `tab-grow ${DWELL}ms linear both` : undefined,
                    }}
                    aria-hidden
                  />
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="relative min-h-[24rem]">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              id={`how-panel-${s.id}`}
              role="tabpanel"
              aria-hidden={i !== active}
              className={`absolute inset-0 transition-opacity duration-500 ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}
            >
              <div className="card h-full overflow-hidden">{s.panel()}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- *
 * The panels
 * ---------------------------------------------------------------- */

function Bar({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex h-11 items-center gap-3 border-b border-line px-4">
      <span className="flex gap-1.5" aria-hidden>
        <span className="size-2.5 rounded-full bg-white/10" />
        <span className="size-2.5 rounded-full bg-white/10" />
        <span className="size-2.5 rounded-full bg-white/10" />
      </span>
      <span className="font-mono text-[12px] text-muted">{title}</span>
      {right ? <span className="ml-auto">{right}</span> : null}
    </div>
  );
}

function AskPanel() {
  return (
    <div className="flex h-full flex-col">
      <Bar title="Your house" right={<span className="text-[12px] text-muted-2">a coding agent on the box</span>} />
      <div className="flex flex-1 flex-col justify-end gap-2.5 p-6">
        <p className="bubble bubble-you text-[15px]">My mom needs a page with the store’s hours.</p>
        <p className="bubble bubble-house text-[15px]">Should it say whether the store is open right now?</p>
        <p className="bubble bubble-you text-[15px]">Yes. And in Spanish, for her customers.</p>
        <p className="bubble bubble-house text-[15px]">Got it. Writing it down.</p>
      </div>
    </div>
  );
}

function WritePanel() {
  const diff: Array<[string, string]> = [
    [" ", `  "lintel": { … },`],
    ["+", `  "almacen": {`],
    ["+", `    "stage": "live",`],
    ["+", `    "postgres": true,`],
    ["+", `    "auth": { "mode": "native", "healthPath": "/api/healthz" },`],
    ["+", `    "presentation": { "description": "The store's hours, for mom" }`],
    ["+", `  },`],
    [" ", `  "plutus": { … },`],
  ];
  return (
    <div className="flex h-full flex-col">
      <Bar title="the house · main" right={<span className="font-mono text-[12px] text-muted-2">4f2a91c</span>} />
      <div className="border-b border-line px-6 py-5">
        <p className="text-[16px] font-medium">A page with the store’s hours, for mom</p>
        <p className="mt-1.5 text-[13px] text-muted">
          1 file changed · written by the agent from your request · <span className="text-status-ok">checks passed</span>
        </p>
      </div>
      <div className="flex-1 overflow-hidden px-2 py-3 font-mono text-[12.5px] leading-[1.75]">
        <p className="px-4 pb-1 text-muted-2">site/apps.json</p>
        {diff.map(([sign, line], i) => (
          <p
            key={i}
            className={`whitespace-pre px-4 ${sign === "+" ? "bg-[rgba(63,182,122,0.09)] text-[#b9e6cd]" : "text-muted"}`}
          >
            <span className="mr-3 inline-block w-2 text-muted-2">{sign}</span>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

function BuildPanel() {
  const lines: Array<[string, string, string]> = [
    ["0.0s", "webhook verified", "push to main · almacen · 9c1e07d"],
    ["0.4s", "plan", "node 24 · pnpm · railpack"],
    ["38.2s", "build", "image built on the box"],
    ["51.7s", "checks", "typecheck · tests · lint"],
    ["53.0s", "push", "registry.toscanini.me/almacen@sha256:7b3e…"],
    ["58.9s", "deploy", "almacen started, /api/healthz 200"],
  ];
  return (
    <div className="flex h-full flex-col">
      <Bar title="almacen · build #1" right={<span className="text-[12px] text-status-ok">● Ready</span>} />
      <div className="flex-1 px-6 py-5 font-mono text-[12.5px]">
        {lines.map(([t, step, what]) => (
          <p key={step} className="grid grid-cols-[3.6rem_1.2rem_7.5rem_1fr] items-baseline gap-2 py-[0.55rem] text-muted">
            <span className="text-muted-2">{t}</span>
            <span className="text-status-ok">✓</span>
            <span className="text-fg">{step}</span>
            <span className="truncate">{what}</span>
          </p>
        ))}
        <p className="mt-4 border-t border-line pt-4 text-[12px] text-muted-2">The outcome goes back to GitHub as a check run.</p>
      </div>
    </div>
  );
}

function ShipPanel() {
  return (
    <div className="flex h-full flex-col">
      <Bar
        title={
          <span className="inline-flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            almacen.toscanini.me
          </span>
        }
      />
      <div className="grid flex-1 place-items-center bg-[#f6f1e8] p-6 text-[#221a14]">
        <div className="w-full max-w-[22rem]">
          <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-[#8a7b6e]">Almacén</p>
          <p className="mt-2 text-[2rem] font-semibold leading-none tracking-[-0.03em]">Abierto ahora</p>
          <p className="mt-2 flex items-center gap-2 text-[14px] text-[#2f7a4f]">
            <span className="size-2 rounded-full bg-[#3f9a63]" aria-hidden />
            Cierra a las 20:30
          </p>
          <dl className="mt-6 divide-y divide-[#e4dccf] border-y border-[#e4dccf] text-[14px]">
            <div className="flex justify-between py-2.5">
              <dt>Lunes a sábado</dt>
              <dd className="font-mono text-[13px]">8:00–12:30 · 16:00–20:30</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt>Domingo</dt>
              <dd className="font-mono text-[13px]">9:00–13:00</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line px-5 py-3 text-[12px] text-muted">
        <span>
          <span className="text-status-ok">✓</span> certificate
        </span>
        <span>
          <span className="text-status-ok">✓</span> sign-in
        </span>
        <span>
          <span className="text-status-ok">✓</span> database
        </span>
        <span>
          <span className="text-status-ok">✓</span> health check
        </span>
      </div>
    </div>
  );
}

function UndoPanel() {
  const rows: Array<{ when: string; what: string; tag?: string; strike?: boolean; hot?: boolean }> = [
    { when: "now", what: "Revert: a page with the store’s hours", tag: "applied", hot: true },
    { when: "2m", what: "A page with the store’s hours, for mom", tag: "reverted", strike: true },
    { when: "Oct 16", what: "lintel’s database moves back home after the hackathon" },
    { when: "Oct 9", what: "hermes gets storage of its own" },
    { when: "Oct 2", what: "sankofa goes public. The first try failed and undid itself" },
  ];
  return (
    <div className="flex h-full flex-col">
      <Bar title="the house · history" right={<span className="btn btn-ghost btn-sm pointer-events-none">Revert</span>} />
      <ol className="flex-1 px-2 py-2">
        {rows.map((r) => (
          <li
            key={r.what}
            className={`grid grid-cols-[4rem_1fr_auto] items-baseline gap-3 rounded-md px-4 py-3 text-[14px] ${r.hot ? "bg-white/[0.04]" : ""}`}
          >
            <span className="font-mono text-[12px] text-muted-2">{r.when}</span>
            <span className={r.strike ? "text-muted line-through decoration-white/30" : "text-fg"}>{r.what}</span>
            {r.tag ? (
              <span className={`font-mono text-[11px] ${r.tag === "applied" ? "text-status-ok" : "text-muted-2"}`}>{r.tag}</span>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
