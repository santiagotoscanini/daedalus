import { type ReactNode, useState } from "react";
import { Reveal } from "~/components/reveal";
import { AgentInstall } from "~/components/sections/agent-install";
import { SectionHeading } from "~/components/ui/section-heading";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";

/** The catalog (nix/README.md, "The catalog"): the spine example-host
 * switches on, with stirling-pdf as its one example leaf, and the leaves a
 * host turns on itself. */
const CATALOG = [
  {
    label: "On in the template",
    ids: [
      "apps",
      "app-db",
      "cloudflared",
      "gatus",
      "healthchecks",
      "logging",
      "monitoring",
      "pihole",
      "pocket-id",
      "registry",
      "traefik",
      "stirling-pdf",
    ],
  },
  {
    label: "Yours to switch on",
    ids: ["factorio", "grocy", "intel-gpu-exporter", "metube", "myspeed", "verdaccio", "wg-easy"],
  },
];

/** The two pieces: the engine for the box, the agent for the machines the
 * box does not run. Two cards on one row. The engine's is one line and a
 * link to where it lives; the agent's picks a system first, then copies that
 * system's line (agent-install.tsx). */
export function GetIt() {
  return (
    <section id="get" className="scroll-mt-28 py-32">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="Get it"
          title="Two pieces."
          sub="The engine runs the box. The agent runs on the other machines you want it to see, a desktop with a GPU or a laptop, and links each one back to it."
        />
        <div className="mx-auto mt-16 grid max-w-4xl gap-5 md:grid-cols-2">
          <Reveal>
            <Card
              platform="NixOS"
              title="The engine"
              body="A flake input. One import gives a NixOS host the control plane, the catalog of modules it can switch on, and a configuration to start from."
            >
              <Command text={INIT} />
              <p className="mt-2.5 text-pretty text-[12px] leading-relaxed text-dim">
                In an empty directory; then fill in the host and rebuild.
              </p>
              {/* The catalog as nix/README.md lists it: what example-host switches
                  on, and the leaves beside it. Resync when a module moves in. */}
              <dl className="mt-7 grid gap-4 border-t border-hairline pt-6">
                {CATALOG.map((c) => (
                  <div key={c.label}>
                    <dt className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-dim">
                      {c.label}
                    </dt>
                    <dd className="mt-2 font-mono text-[12px] leading-[1.9] text-muted">
                      {c.ids.join(" · ")}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-auto flex flex-wrap gap-3 pt-7">
                <a href={REPO} className="btn btn-primary h-11 px-5">
                  The engine on GitHub
                </a>
              </div>
            </Card>
          </Reveal>
          <Reveal delay={0.08}>
            <Card
              platform="Windows · macOS · Linux"
              title="The agent"
              body="One outbound TLS link to the box per machine, each side pinning the other's key, approved on Settings › Machines before anything is sent to it. It reports the machine, keeps it awake, runs Claude Code's remote control, installs and runs a local model server, and updates itself from signed releases."
            >
              <AgentInstall />
            </Card>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function Card({
  platform,
  title,
  body,
  children,
}: {
  platform: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className="card flex h-full min-w-0 flex-col p-7">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{platform}</p>
      <h3 className="mt-4 text-[1.35rem] font-semibold leading-snug tracking-[-0.01em]">
        {title}
      </h3>
      <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">{body}</p>
      {children}
    </div>
  );
}

/** The engine's one line, with a copy button. Wraps rather than scrolls: it
 * does not fit a card on a phone, and a clipped command with no scrollbar
 * reads as a shorter one. */
function Command({ text }: { text: string }) {
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

