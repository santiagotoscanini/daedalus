import { Mark } from "~/components/marks";
import { AgentInstall, InstallCard } from "~/components/sections/agent-install";
import { Command } from "~/components/ui/command";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const INIT = "nix flake init -t github:santiagotoscanini/daedalus#config";

/** The close, on the band the footer continues: the line, then the two pieces, each one command and
 * one button. What either one does next is the setup's to say, not the landing's: this is only the
 * first step, and the docs are a link away in the FAQ and the footer. The engine's "View on GitHub"
 * is the close's one filled button; the agent's is secondary. From 1024px the cards hold columns 1–6
 * and 7–12 at one height; below, they stack. */
export function GetIt() {
  return (
    <section id="get" aria-labelledby="get-title" className="groove band pb-18 pt-20 sm:pb-24 sm:pt-28 lg:pb-28 lg:pt-32">
      <div className="wrap">
        <h2 id="get-title" className="t-display-xl max-w-[900px]">
          Start with the computer you already have.
        </h2>
        {/* balanced, so "to it." is never split across the turn */}
        <p className="t-lead mt-6 max-w-[588px] text-balance">
          The engine runs the box. The agent joins your other machines to it. Both are open source, MIT licensed.
        </p>
        <div className="grid-12 mt-16 max-lg:grid max-lg:gap-4">
          <InstallCard
            title="The engine"
            control={
              // the one system the engine runs on, in the same switch the agent's card carries, with its
              // only position selected, so both headers hold the same object. It does nothing, and the
              // description says the same in words, so it is hidden from assistive technology.
              <div className="seg" aria-hidden>
                <span className="seg-item" aria-selected="true">
                  <Mark id="nixos" size={14} />
                  NixOS
                </span>
              </div>
            }
            description="For NixOS. Start a house from the template."
            command={<Command text={INIT} label="Start from the template" />}
            action={
              <a href={REPO} className="btn btn-primary">
                <Mark id="github" size={16} />
                View on GitHub
              </a>
            }
          />
          <AgentInstall />
        </div>
      </div>
    </section>
  );
}
