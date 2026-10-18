import type { ReactNode } from "react";
import { Logo } from "~/components/logo";
import { SectionHeading } from "~/components/ui/section-heading";

/** The tree, already cut: the six choices every app would otherwise make for itself, each answered
 * once by the platform and drawn as the small piece of UI it becomes.
 *
 * Each answer is what the engine does today (ARCHITECTURE.md, the apps registry): Pocket ID's
 * passkeys as one sign-in for the house; a database per app on the shared Postgres, inside the
 * snapshotted state; one LiteLLM key per app in front of the house's model server and the frontier;
 * the box's own build on a push; the three exposure rungs with the wildcard certificate and DNS;
 * every change a commit, with a failed rebuild putting the previous bytes back. */

interface Decision {
  q: string;
  title: string;
  text: string;
  art: ReactNode;
}

const DECISIONS: Decision[] = [
  {
    q: "How do people sign in?",
    title: "One sign-in for the house",
    text: "Passkeys, through the house’s own identity provider. Every app gets it without writing a login.",
    art: <SignIn />,
  },
  {
    q: "Where does the data live?",
    title: "Postgres, on the box",
    text: "A database for each app on one cluster, snapshotted every hour with the rest of the house.",
    art: <Databases />,
  },
  {
    q: "How does it reach a model?",
    title: "One key for every model",
    text: "A gateway in front of the models on your own GPU and the frontier ones, so an app never chooses a provider.",
    art: <Models />,
  },
  {
    q: "How does it ship?",
    title: "Push to main",
    text: "The box builds the image itself, keeps it in its own registry and deploys it. There is no CI to set up.",
    art: <Builds />,
  },
  {
    q: "Who can reach it?",
    title: "A switch, not a project",
    text: "Off, the house, or the internet. The address, the certificate and the DNS follow the switch.",
    art: <Reach />,
  },
  {
    q: "What if it’s wrong?",
    title: "Every change is a commit",
    text: "A change that fails to build puts the machine back by itself. One that builds can be reverted in one step.",
    art: <Commits />,
  },
];

export function Decisions() {
  return (
    <section id="platform" aria-labelledby="platform-title" className="cell scroll-mt-16">
      <div className="px-6 pb-14 pt-24 sm:px-12 sm:pt-32">
        <SectionHeading
          id="platform-title"
          label="The platform"
          title={
            <>
              Every decision, <span className="text-muted">made before the first prompt.</span>
            </>
          }
          sub="Before writing anything that matters, an engineer walks a tree of choices. daedalus makes them once, for every app, so all that’s left to talk about is what you want."
        />
      </div>
      <div className="grid border-t border-hairline sm:grid-cols-2 lg:grid-cols-3">
        {DECISIONS.map((d, i) => (
          <article
            key={d.title}
            className={`flex flex-col border-hairline p-6 sm:p-8 ${i % 3 !== 2 ? "lg:border-r" : ""} ${i % 2 === 0 ? "sm:max-lg:border-r" : ""} ${i < 3 ? "lg:border-b" : ""} ${i < 4 ? "max-lg:border-b" : ""} max-sm:border-b`}
          >
            <div className="grid h-44 place-items-center rounded-lg border border-hairline bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.035),transparent_70%)]">
              {d.art}
            </div>
            <p className="mt-6 font-mono text-[11.5px] text-muted-2">{d.q}</p>
            <h3 className="mt-2 text-[17px] font-medium tracking-[-0.01em]">{d.title}</h3>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{d.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- *
 * The small pictures
 * ---------------------------------------------------------------- */

function SignIn() {
  return (
    <div className="w-[13.5rem] rounded-lg border border-line bg-panel p-4 text-center">
      <div className="flex justify-center">
        <Logo size={22} />
      </div>
      <p className="mt-2 text-[13px] font-medium">Sign in to almacen</p>
      <p className="mt-3 flex h-8 items-center justify-center gap-2 rounded-md bg-fg text-[12px] font-medium text-app">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="9" cy="8" r="4" />
          <path d="M2 21c0-4 3-6 7-6M17 11v10M17 11a3 3 0 1 1 0 .01M15 17h4" />
        </svg>
        Continue with a passkey
      </p>
      <p className="mt-2.5 text-[11px] text-muted-2">id.toscanini.me</p>
    </div>
  );
}

function Databases() {
  const rows: Array<[string, string]> = [
    ["almacen", "12 MB"],
    ["hermes", "1.4 GB"],
    ["sankofa", "380 MB"],
    ["voyra", "96 MB"],
  ];
  return (
    <div className="w-[15rem] overflow-hidden rounded-lg border border-line bg-panel font-mono text-[11.5px]">
      <p className="flex justify-between border-b border-line px-3 py-2 text-muted-2">
        <span>database</span>
        <span>size</span>
      </p>
      {rows.map(([n, s], i) => (
        <p key={n} className={`flex items-center justify-between px-3 py-[0.42rem] ${i === 0 ? "bg-white/[0.04] text-fg" : "text-muted"}`}>
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-status-ok" aria-hidden />
            {n}
          </span>
          <span>{s}</span>
        </p>
      ))}
    </div>
  );
}

function Models() {
  return (
    <div className="w-[15.5rem] font-mono text-[11.5px]">
      <p className="rounded-t-lg border border-line bg-panel px-3 py-2 text-muted">
        <span className="text-muted-2">LITELLM_API_KEY=</span>sk-••••••••
      </p>
      <div className="rounded-b-lg border border-t-0 border-line">
        {[
          ["smart", "gaming PC"],
          ["voice", "gaming PC"],
          ["frontier", "the cloud"],
        ].map(([m, where]) => (
          <p key={m} className="flex items-center justify-between px-3 py-[0.45rem] text-muted">
            <span className="text-fg">{m}</span>
            <span className="flex items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${where === "the cloud" ? "bg-muted-2" : "bg-status-ok"}`} aria-hidden />
              {where}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}

function Builds() {
  return (
    <div className="w-[15rem] space-y-1.5 font-mono text-[11.5px]">
      {[
        ["build", "38s"],
        ["checks", "13s"],
        ["push", "1s"],
        ["deploy", "6s"],
      ].map(([s, t]) => (
        <p key={s} className="flex items-center justify-between rounded-md border border-line bg-panel px-3 py-1.5">
          <span className="flex items-center gap-2">
            <span className="text-status-ok">✓</span>
            <span className="text-fg">{s}</span>
          </span>
          <span className="text-muted-2">{t}</span>
        </p>
      ))}
    </div>
  );
}

function Reach() {
  return (
    <div className="w-[15rem]">
      <div className="grid grid-cols-3 rounded-lg border border-line bg-panel p-1 text-center text-[12px]">
        <span className="rounded-md py-1.5 text-muted">Off</span>
        <span className="rounded-md py-1.5 text-muted">House</span>
        <span className="rounded-md bg-white/[0.09] py-1.5 font-medium text-fg">Internet</span>
      </div>
      <p className="mt-3 flex items-center justify-center gap-1.5 font-mono text-[11.5px] text-muted">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        almacen.toscanini.me
      </p>
    </div>
  );
}

function Commits() {
  return (
    <div className="w-[15.5rem] font-mono text-[11.5px]">
      {[
        ["e81d4c0", "Revert: the store’s page", true],
        ["4f2a91c", "A page with the store’s hours", false],
        ["a77c013", "hermes gets storage", false],
      ].map(([sha, msg, hot]) => (
        <p
          key={sha as string}
          className={`flex items-center gap-2.5 border-l px-3 py-[0.45rem] ${hot ? "border-fg text-fg" : "border-line text-muted"}`}
        >
          <span className="text-muted-2">{sha}</span>
          <span className="truncate">{msg}</span>
        </p>
      ))}
    </div>
  );
}
