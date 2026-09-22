import { type ReactNode, useState } from "react";
import { AppleLogo, GitHubLogo, WindowsLogo } from "~/components/icons";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";
/** The installers are served from this site (copied from agent/install.ps1
 * and agent/install.sh at build time), so neither line names a version: the
 * script finds the newest agent release itself. */
const AGENT_INSTALL_WINDOWS = "irm https://daedalus.toscanini.me/install.ps1 | iex";
const AGENT_INSTALL_MACOS = "curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh";
/** GitHub's release search matches titles, not tags: the releases are titled
 * "daedalus-agent <version>", so that is the word that lists them. */
const AGENT_RELEASES = `${REPO}/releases?q=daedalus-agent`;
const AGENT_README = `${REPO}/blob/main/agent/README.md`;

/** The two downloads: the engine for the box, the agent for the machine the
 * box does not run. Two cards on one row, each with the line that installs
 * it and a button to where it lives. The state tag says how far each has
 * come — the engine runs a box in production, the agent is early — so the
 * page never dresses one as the other. */
export function GetIt() {
  return (
    <section id="get" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="Get it"
          title="Two machines, two pieces."
          sub="The engine runs the box. The agent runs the other machines the box only talks to — a GPU box serving models, a Mac on the desk."
        />
        <div className="mx-auto mt-16 grid max-w-4xl gap-5 md:grid-cols-2">
          <Reveal>
            <Card
              platform="Linux · NixOS"
              state="ships"
              title="The engine"
              body="A flake input. One import gives a NixOS host the control plane, the catalog of modules it can switch on, and a configuration to start from."
              commands={[{ text: INIT, note: "In an empty directory; then fill in the host and rebuild." }]}
              actions={[{ href: REPO, label: "Get it on GitHub", icon: <GitHubLogo size={15} /> }]}
            />
          </Reveal>
          <Reveal delay={0.08}>
            <Card
              platform="Windows · macOS"
              state="early"
              title="The agent"
              body="A service for the machines the box does not run. It keeps them awake, shows itself in the tray or the menu bar, runs Claude Code's remote control there, and updates itself from each new release — one install, then never a walk to it again."
              commands={[
                { label: "Windows", text: AGENT_INSTALL_WINDOWS, note: "In an administrator PowerShell." },
                { label: "macOS", text: AGENT_INSTALL_MACOS, note: "In a terminal; it asks for your password once." },
              ]}
              commandNote={
                <>
                  What it installs, and how it updates, is in the{" "}
                  <a
                    href={AGENT_README}
                    className="underline decoration-hairline underline-offset-4 transition-colors hover:text-fg"
                  >
                    agent's README
                  </a>
                  .
                </>
              }
              actions={[
                { href: AGENT_RELEASES, label: "Windows", icon: <WindowsLogo size={14} /> },
                { href: AGENT_RELEASES, label: "macOS", icon: <AppleLogo size={14} /> },
              ]}
            />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Card({
  platform,
  state,
  title,
  body,
  commands,
  commandNote,
  actions,
}: {
  platform: string;
  state: "ships" | "early";
  title: string;
  body: string;
  commands: { label?: string; text: string; note: ReactNode }[];
  commandNote?: ReactNode;
  actions: { href: string; label: string; icon: ReactNode }[];
}) {
  return (
    <div className="card flex h-full min-w-0 flex-col p-7">
      <Kicker platform={platform} state={state} />
      <h3 className="mt-4 text-[1.35rem] font-semibold leading-snug tracking-[-0.01em]">
        {title}
      </h3>
      <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">{body}</p>
      {commands.map((c) => (
        <div key={c.text}>
          <Command text={c.text} label={c.label} />
          <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-dim">{c.note}</p>
        </div>
      ))}
      {commandNote !== undefined && (
        <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-dim">{commandNote}</p>
      )}
      <div className="mt-auto flex flex-wrap gap-3 pt-7">
        {actions.map((a) => (
          <a key={a.label} href={a.href} className="btn btn-primary h-11 px-5">
            {a.icon}
            {a.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/** The one line that installs it, with a copy button. Wraps rather than
 * scrolls: neither line fits a card on a phone, and a clipped command with
 * no scrollbar reads as a shorter one. */
function Command({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the text is
      // selectable either way.
    }
  };
  return (
    <div className="mt-6 flex min-w-0 items-start justify-between gap-3 rounded-lg border border-hairline bg-black/30 px-3.5 py-2.5">
      <code className="min-w-0 select-all whitespace-pre-wrap break-all font-mono text-[12px] leading-relaxed text-muted">
        {label !== undefined && <span className="mr-2 text-dim">{label}</span>}
        {text}
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
  );
}

/** The platform and how far it has come, on one line above the card's title. */
function Kicker({ platform, state }: { platform: string; state: "ships" | "early" }) {
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
