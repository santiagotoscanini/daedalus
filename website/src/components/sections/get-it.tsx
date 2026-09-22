import { useState } from "react";
import { GitHubLogo, WindowsLogo } from "~/components/icons";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";
const AGENT_PLAN = `${REPO}/blob/main/PLAN.md#features`;

/** The two downloads: the engine for the box, the agent for the machine the
 * box does not run. Two cards on one row, deliberately unequal — the
 * engine ships, the agent does not yet, and the page says which is which
 * rather than dressing the second as the first. A disabled button is a
 * promise with a date on it; a working button that led nowhere would be a
 * lie the visitor discovers. */
export function GetIt() {
  return (
    <section id="get" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="Get it"
          title="Two machines, two pieces."
          sub="The engine runs the box. The agent runs the second machine the box only talks to — a GPU box serving models."
        />
        <div className="mx-auto mt-16 grid max-w-4xl gap-5 md:grid-cols-2">
          <Reveal>
            <Engine />
          </Reveal>
          <Reveal delay={0.08}>
            <Agent />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Engine() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INIT);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the text is
      // selectable either way.
    }
  };

  return (
    <div className="card flex h-full min-w-0 flex-col p-7">
      <Kicker platform="Linux · NixOS" state="ships" />
      <h3 className="mt-4 text-[1.35rem] font-semibold leading-snug tracking-[-0.01em]">
        The engine
      </h3>
      <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">
        A flake input. One import gives a NixOS host the control plane, the catalog of modules it
        can switch on, and a configuration to start from.
      </p>
      {/* The template command, not `git clone`: the clone is for reading,
          this is for running, and it is the first command a new host types.
          It wraps rather than scrolls: 56 characters fit no card on a phone,
          and a clipped command with no scrollbar reads as a shorter one. */}
      <div className="mt-6 flex min-w-0 items-start justify-between gap-3 rounded-lg border border-hairline bg-black/30 px-3.5 py-2.5">
        <code className="min-w-0 select-all whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-muted">
          {INIT}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-live="polite"
          className="shrink-0 rounded-md px-2 py-1 font-mono text-[11px] text-dim transition-colors hover:bg-white/5 hover:text-accent"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="mt-auto pt-7">
        <a href={REPO} className="btn btn-primary h-11 w-full px-5 sm:w-auto">
          <GitHubLogo size={15} />
          Get it on GitHub
        </a>
      </div>
    </div>
  );
}

function Agent() {
  return (
    <div className="card flex h-full min-w-0 flex-col p-7">
      <Kicker platform="Windows" state="in progress" />
      <h3 className="mt-4 text-[1.35rem] font-semibold leading-snug tracking-[-0.01em]">
        The agent
      </h3>
      <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">
        A service for the machine that serves the models. It keeps that machine awake, reports to
        the box that it is, and updates itself to the version the box pins — one install, then
        never a walk to it again.
      </p>
      <p className="mt-3 text-pretty text-[12.5px] leading-relaxed text-dim">
        Being built now.{" "}
        <a href={AGENT_PLAN} className="underline decoration-hairline underline-offset-4 transition-colors hover:text-fg">
          The plan
        </a>{" "}
        says what ships first and what waits.
      </p>
      <div className="mt-auto pt-7">
        {/* `aria-disabled` on a real button, not a styled span: assistive
            tech announces a disabled control where a span would announce
            nothing, and the label carries the reason. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="btn btn-ghost h-11 w-full cursor-not-allowed px-5 opacity-50 sm:w-auto"
        >
          <WindowsLogo size={14} />
          Download for Windows
        </button>
      </div>
    </div>
  );
}

/** The platform and whether it ships, on one line above the card's title. */
function Kicker({ platform, state }: { platform: string; state: "ships" | "in progress" }) {
  const color = state === "ships" ? "#4ea87a" : "#d9a441";
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{platform}</p>
      <span
        className="inline-flex rounded-full border px-2 py-px font-mono text-[9.5px] uppercase tracking-[0.1em]"
        style={{ color, borderColor: `${color}59` }}
      >
        {state}
      </span>
    </div>
  );
}
