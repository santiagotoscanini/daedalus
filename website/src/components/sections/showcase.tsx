import { AppMark } from "~/components/demo/app-marks";
import { ArrowUpRight } from "~/components/icons";
import { SectionHeader } from "~/components/ui/section-header";

/** Made on it: apps the reference box builds and serves, each for someone, shown as their own
 * landing pages (public/apps/*.jpg: each app's live page at 1280×800, the site nav cropped off,
 * shot at 1.5× by the shotter driver dd-app-shots-v3.mjs). That every one of them looks like
 * nothing else is the point. Who each is for is said as the essay says it.
 *
 * A bento on the 12-column grid from 1024px (7+5, then 4+4+4), six columns from 768px, and below
 * that a horizontal snap rail that bleeds to the viewport edges. `pos` is each picture's
 * object-position. The pictures are 16:10, so it only bites in the 336px-tall wells of the first
 * row: lintel stays at the left because any crop further right slices its headline mid-word
 * (checked with dd-app-crops.mjs and dd-fix3-sim2.mjs).
 *
 * Between 1024 and 1160px anansi's person line takes two lines in its 4-column card while hermes
 * and voyra take one, so all three hold two lines there and their descriptions start level. */

const APPS: Array<{ name: string; forWhom: string; what: string; pos: string; layout: string; wide?: true }> = [
  {
    name: "sankofa",
    forWhom: "For friends writing history PhDs at Harvard",
    what: "Reads, corrects and indexes 19th-century handwritten documents, and answers with quotations checked against the page.",
    pos: "30% 30%",
    layout: "md:col-span-6 lg:col-span-7",
    wide: true,
  },
  {
    name: "lintel",
    forWhom: "For a move to San Francisco",
    what: "Scan an apartment with a phone and furnish it before you arrive. Made in five hours at Vercel’s Fast Forward hackathon, which it won.",
    pos: "0% 35%",
    layout: "md:col-span-6 lg:col-span-5",
    wide: true,
  },
  {
    name: "hermes",
    forWhom: "For one reader",
    what: "The writers and documents one person cares about, read aloud in a favourite cloned voice.",
    pos: "45% 35%",
    layout: "md:col-span-3 lg:col-span-4",
  },
  {
    name: "voyra",
    forWhom: "For a family",
    what: "Plans a trip day by day and shares it with the people coming along.",
    pos: "50% 45%",
    layout: "md:col-span-3 lg:col-span-4",
  },
  {
    name: "anansi",
    forWhom: "For a person and their therapist",
    what: "A quiet place to understand yourself better, with nothing that notifies you.",
    pos: "30% 30%",
    layout: "md:col-span-6 lg:col-span-4",
  },
];

export function Showcase() {
  return (
    <section id="made" aria-labelledby="made-title" className="groove py-18 sm:py-24 lg:py-28">
      <div className="wrap">
        <SectionHeader
          id="made-title"
          title="None had a market. Each one has a person."
          lead="Things no company would build, because one life isn’t a market. They run on the same box, built and served by daedalus."
        />
        <ul className="grid-12 mt-10 gap-y-6 max-md:flex max-md:snap-x max-md:snap-mandatory max-md:gap-3 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-sm:-mx-6 max-sm:scroll-px-6 max-sm:px-6 sm:max-md:-mx-10 sm:max-md:scroll-px-10 sm:max-md:px-10 md:max-lg:grid md:max-lg:grid-cols-6 md:max-lg:gap-6 lg:mt-16">
          {APPS.map((a) => (
            <li key={a.name} className={`max-md:w-[85%] max-md:shrink-0 max-md:snap-start ${a.layout}`}>
              <a
                href={`https://${a.name}.toscanini.me`}
                className="card group flex h-full flex-col p-2 transition-colors duration-(--d-1) ease-ui hover:border-edge-3"
              >
                <div
                  className={`relative aspect-[16/10] overflow-hidden rounded-chip after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_rgba(0,0,0,.35)] ${
                    a.wide ? "lg:aspect-auto lg:h-[336px]" : ""
                  }`}
                >
                  <img
                    src={`/apps/${a.name}.jpg`}
                    alt={`The ${a.name} landing page`}
                    width={1920}
                    height={1200}
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                    style={{ objectPosition: a.pos }}
                  />
                </div>
                <div className="flex flex-1 flex-col px-3 pt-4 pb-3">
                  <p className={a.wide ? "t-title" : "t-title lg:max-[1160px]:min-h-14"}>{a.forWhom}</p>
                  <p className="t-body mt-2">{a.what}</p>
                  <p className="t-small mt-auto flex items-center gap-2 pt-4">
                    <AppMark name={a.name} size={16} />
                    <span className="font-medium text-ink-2">{a.name}</span>
                    <span className="text-ink-4">{a.name}.toscanini.me</span>
                    <ArrowUpRight
                      size={12}
                      className="ml-auto text-ink-4 transition-colors duration-(--d-1) ease-ui group-hover:text-ink-1"
                    />
                  </p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
