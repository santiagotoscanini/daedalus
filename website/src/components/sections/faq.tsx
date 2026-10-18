import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ArrowRight, ChevronDown } from "~/components/icons";

/** The questions a careful reader asks before cloning, answered plainly.
 * An FAQ, not a confession: the page speaks as the product. Each answer is
 * checked against the repository (README, ARCHITECTURE.md, nix/README.md's
 * "What is NOT done yet"); keep it that way when the facts move.
 *
 * From 1024px the heading holds columns 1–4 and stays in view while the list
 * (columns 6–12) scrolls past it; below that the list follows the heading.
 * Native <details>, so it works before hydration and with no script; only the
 * chevron moves, and the answer opens without a height animation. */

const QUESTIONS: Array<{ q: string; a: ReactNode }> = [
  {
    q: "What does it cost?",
    a: "Nothing. It is MIT-licensed, and there is no account, plan or hosted tier. You bring the machine and a domain.",
  },
  {
    q: "What does it need?",
    a: "A machine running NixOS, a domain on Cloudflare for DNS and the public tunnel, and a GitHub App for builds, which the control plane creates for you. The docs list every account and key that lives outside the repository.",
  },
  {
    q: "Is there a release?",
    a: "Not for the engine yet: there is no tagged release, so a clone follows main. The agent ships tagged releases. Everything a box needs to log in to its control plane is in the catalog of modules; many of the stacks it was built beside are still being moved in.",
  },
  {
    q: "What does it run?",
    a: (
      <>
        The apps you build, a catalog of services the engine can switch on, and the outside services it talks
        to.{" "}
        <Link to="/integrations" className="link">
          The integrations page
        </Link>{" "}
        shows every one.
      </>
    ),
  },
  {
    q: "What can the control plane do to the machine?",
    a: "Very little on its own. It runs as an unprivileged container with no sudo, no container socket and no SSH key. Its one door is a socket to the agent on the box, which can start a fixed list of systemd units that the NixOS configuration wrote down.",
  },
  {
    q: "What if the machine dies?",
    a: "The repository is the system. Every input is pinned and every secret is encrypted in it, so a fresh checkout and one decryption key rebuild the same machine. App data is not in the repository; it comes back from the replicated snapshots, wherever you keep them.",
  },
  {
    q: "Does it reach my other machines?",
    a: "Only the ones you install the agent on. Each one opens a single TLS connection to the box, both sides pinning each other's key, and waits until you approve it before the box tells it anything.",
  },
];

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="groove pb-18 pt-18 sm:pb-24 sm:pt-24 lg:pb-28 lg:pt-28">
      <div className="wrap grid-12 items-start">
        {/* sticky on the column, not the heading: a sticky element only travels inside its parent */}
        <div className="lg:sticky lg:top-28 lg:col-span-4 lg:self-start">
          <h2 id="faq-title" className="t-title-l">
            Before you clone it.
          </h2>
          <Link
            to="/docs"
            className="t-body mt-4 flex w-fit items-center gap-1.5 font-medium text-ink-1 decoration-white/60 underline-offset-4 hover:underline"
          >
            Read the docs
            <ArrowRight />
          </Link>
        </div>
        <div className="mt-8 border-t border-edge-1 lg:col-span-7 lg:col-start-6 lg:mt-0">
          {QUESTIONS.map((item, i) => (
            <details key={item.q} open={i === 0} className="faq group border-b border-edge-1">
              <summary className="t-body flex min-h-14 cursor-pointer items-center justify-between gap-6 py-4 font-medium text-ink-1">
                {item.q}
                <ChevronDown
                  size={16}
                  className="text-ink-4 transition-transform duration-(--d-2) ease-out group-open:rotate-180"
                />
              </summary>
              <p className="t-body max-w-[600px] pb-5">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
