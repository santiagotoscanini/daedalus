import { AppMark } from "~/components/demo/app-marks";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";

/** Made on it: apps the reference box builds and serves, each for someone, shown as their own
 * landing pages (public/apps/*.jpg, screenshots of each app's live page). That every one of them
 * looks like nothing else is the point. Who each is for is said as the essay says it. */

const APPS: Array<{ name: string; forWhom: string; what: string; wide?: true }> = [
  {
    name: "sankofa",
    forWhom: "For friends writing history PhDs at Harvard",
    what: "Reads, corrects and indexes 19th-century handwritten documents, and answers with quotations checked against the page.",
    wide: true,
  },
  {
    name: "lintel",
    forWhom: "For a move to San Francisco",
    what: "Scan an apartment with a phone and furnish it before you arrive. Made in five hours at Vercel’s Fast Forward hackathon, which it won.",
    wide: true,
  },
  {
    name: "hermes",
    forWhom: "For one reader",
    what: "The writers and documents one person cares about, read aloud in a favourite cloned voice.",
  },
  {
    name: "voyra",
    forWhom: "For a family",
    what: "Plans a trip day by day and makes sharing it with the people coming along effortless.",
  },
  {
    name: "anansi",
    forWhom: "For a person and their therapist",
    what: "A quiet place to understand yourself better, with nothing that notifies you.",
  },
];

export function Showcase() {
  return (
    <section id="made" aria-labelledby="made-title" className="cell scroll-mt-16 px-6 py-24 sm:px-12 sm:py-32">
      <SectionHeading
        id="made-title"
        label="Made on it"
        title={
          <>
            None of these had a market. <span className="text-muted">Each one has a person.</span>
          </>
        }
        sub="Things no company would build, because one life isn’t a market. They run on the same box, built and served by daedalus."
      />
      <Reveal delay={0.06}>
        <ul className="mt-14 grid gap-5 md:grid-cols-6">
          {APPS.map((a) => (
            <li key={a.name} className={a.wide ? "md:col-span-3" : "md:col-span-2"}>
              <a
                href={`https://${a.name}.toscanini.me`}
                className="group block h-full overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-line-2"
              >
                <div className="aspect-[16/10] overflow-hidden border-b border-line">
                  <img
                    src={`/apps/${a.name}.jpg`}
                    alt={`The ${a.name} landing page`}
                    width={1440}
                    height={900}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.02]"
                  />
                </div>
                <div className="p-5">
                  <p className="flex items-center gap-2.5 text-[14px] font-medium">
                    <AppMark name={a.name} size={20} />
                    {a.name}
                    <span className="ml-auto font-mono text-[11.5px] font-normal text-muted-2 transition-colors group-hover:text-muted">
                      {a.name}.toscanini.me ↗
                    </span>
                  </p>
                  <p className="mt-3 text-[15px] text-fg">{a.forWhom}</p>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{a.what}</p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </Reveal>
      <p className="mt-6 text-[13.5px] text-muted-2">
        Most of each one’s decisions were made before its first prompt. The same box runs four more.
      </p>
    </section>
  );
}
