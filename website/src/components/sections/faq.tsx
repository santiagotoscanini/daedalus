import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** The questions a careful reader asks before cloning, answered plainly.
 * An FAQ, not a confession: the page speaks as the product. Each answer is
 * checked against the repository (README, ARCHITECTURE.md, nix/README.md's
 * "What is NOT done yet"); keep it that way when the facts move.
 *
 * Native <details>, so it works before hydration and with no script. */

const QUESTIONS: Array<{ q: string; a: string }> = [
  {
    q: "What does it cost?",
    a: "Nothing. It is MIT-licensed, and there is no account, plan or hosted tier. You bring the machine and a domain.",
  },
  {
    q: "What does it need?",
    a: "A machine running NixOS, a domain on Cloudflare for DNS and the public tunnel, and a GitHub App for builds, which the control plane creates for you. The docs list every account and key that lives outside the repository.",
  },
  {
    q: "Is it finished?",
    a: "No. There is no tagged release yet, so a clone follows main. Everything a box needs to log in to its control plane is in the catalog of modules; many of the stacks it was built beside are still being moved in.",
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
    <section id="faq" className="scroll-mt-28 py-28 sm:py-32">
      <div className="mx-auto max-w-3xl px-6">
        <SectionHeading kicker="Questions" title="Before you clone it." />
        <Reveal delay={0.06}>
          <div className="mt-14 border-t border-line-2">
            {QUESTIONS.map((item, i) => (
              <details
                key={item.q}
                open={i === 0}
                className="faq group border-b border-hairline"
              >
                <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-5 text-[16px] font-medium text-fg transition-colors hover:text-white">
                  {item.q}
                  <span
                    aria-hidden
                    className="font-mono text-[14px] text-dim transition-transform duration-300 group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="-mt-1 max-w-2xl pb-6 text-pretty text-[14.5px] leading-relaxed text-muted">
                  {item.a}
                </p>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
