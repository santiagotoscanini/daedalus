import { Reveal } from "~/components/reveal";

/** The convictions, carried in type alone — no cards, no icons. Three
 * declarations on hairlines, closed by the honest footnote. */

const PRINCIPLES = [
  {
    title: "The repo is the system.",
    body: "Runtime state is never the source of truth. The flake pins every input, sops encrypts every secret in-tree, and any checkout rebuilds this exact machine.",
  },
  {
    title: "Zero host privilege.",
    body: "Daedalus runs in a rootless container and talks to the machine through file-drop bridges watched by systemd. It can't rebuild, restart or read anything the host didn't hand it.",
  },
  {
    title: "Lose the box, keep the cloud.",
    body: "Every container, route, dashboard and alert is declared in the repo. A fresh checkout plus one key rebuilds all of it; the hardware is the only replaceable part.",
  },
];

export function Principles() {
  return (
    <section id="principles" className="scroll-mt-28 py-36">
      <div className="mx-auto max-w-5xl px-6">
        <div className="grid gap-12 sm:grid-cols-3 sm:gap-10">
          {PRINCIPLES.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.07}>
              <div className="border-t border-line-2 pt-6">
                <h2 className="text-balance text-[1.35rem] font-semibold leading-snug tracking-[-0.01em]">
                  {p.title}
                </h2>
                <p className="mt-3 text-pretty text-[14px] leading-relaxed text-muted">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.2}>
          <p className="mt-16 text-center font-mono text-[12px] tracking-wide text-dim">
            Pre-release. One operator, one box, in production every day.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
