import { Reveal } from "~/components/reveal";
import { AgentInstall } from "~/components/sections/agent-install";
import { Command } from "~/components/ui/command";
import { SectionHeading } from "~/components/ui/section-heading";
import { Mark } from "~/components/walk/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";

/** The two pieces, each a button and one command. What either one does next
 * is the setup's to say, not the landing's: this is only the first step. */
export function GetIt() {
  return (
    <section id="get" className="scroll-mt-28 py-28 sm:py-36">
      <div className="mx-auto max-w-6xl px-6">
        <SectionHeading
          kicker="Get it"
          title="Two pieces."
          sub="The engine runs the box. The agent joins your other machines to it."
        />
        <div className="mx-auto mt-14 grid max-w-5xl gap-5 md:grid-cols-2">
          <Reveal className="min-w-0">
            <div className="card flex h-full flex-col p-6 sm:p-8">
              <div className="flex h-9 items-center gap-2 text-muted">
                <Mark id="nixos" size={22} />
              </div>
              <h3 className="mt-6 text-[1.45rem] font-semibold leading-snug tracking-[-0.015em]">
                The engine
              </h3>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-muted">For NixOS.</p>
              <a href={REPO} className="btn btn-primary mt-7 h-11 self-start px-5">
                <Mark id="github" size={17} />
                View on GitHub
              </a>
              <div className="mt-auto pt-6">
                <Command text={INIT} label="Start from the template" />
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.08} className="min-w-0">
            <div className="card flex h-full flex-col p-6 sm:p-8">
              <AgentInstall />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
