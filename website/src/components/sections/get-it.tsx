import { Reveal } from "~/components/reveal";
import { AgentInstall } from "~/components/sections/agent-install";
import { Command } from "~/components/ui/command";
import { SectionHeading } from "~/components/ui/section-heading";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";

/** The two pieces, each a button and one command. What either one does next
 * is the setup's to say, not the landing's: this is only the first step. */
export function GetIt() {
  return (
    <section id="get" aria-labelledby="get-title" className="cell scroll-mt-16 px-6 py-24 sm:px-12 sm:py-32">
      <div>
        <SectionHeading
          id="get-title"
          label="Get started"
          title={
            <>
              Two pieces. <span className="text-muted">Both open source.</span>
            </>
          }
          sub="The engine runs the box. The agent joins your other machines to it."
        />
        <div className="mt-14 grid gap-5 md:grid-cols-2">
          <Reveal className="min-w-0">
            <div className="card flex h-full flex-col p-6 sm:p-8">
              <div className="flex h-9 items-center gap-2 text-muted">
                <Mark id="nixos" size={22} />
              </div>
              <h3 className="mt-6 text-[20px] font-semibold tracking-[-0.02em]">The engine</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">For NixOS. Start a house from the template.</p>
              <a href={REPO} className="btn btn-primary mt-7 self-start">
                <Mark id="github" size={16} />
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
