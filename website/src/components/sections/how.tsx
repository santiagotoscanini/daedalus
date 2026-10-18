import { HowRecord, HowRecordCard, type RecordStep } from "~/components/demo/fragments";
import { SectionHeader } from "~/components/ui/section-header";

/** How it works: one request, start to finish, as one record of what the box did, with a note
 * beside each part. The asking itself belongs to the hero; this section starts where the agent
 * writes the change down. The record and its sources are in demo/fragments.tsx.
 *
 * Nothing here moves. From 1024px the notes (cols 1–3) and the record (cols 5–12) share one grid:
 * the record's header and four groups sit on subgrid rows, and so do the notes, so each note starts
 * level with its group and a leader crosses col 4 at the title's midline. Below 1024px each note
 * sits above its own card of the record, and the one-piece record is not rendered. */

interface Step {
  group: RecordStep;
  time: string;
  title: string;
  text: string;
}

const STEPS: Step[] = [
  {
    group: "written",
    time: "0:00",
    title: "It is written down",
    text: "The whole machine is described in files. Your request becomes a commit to them, with a message that says what changed and why.",
  },
  {
    group: "built",
    time: "0:53",
    title: "The box builds it",
    text: "A push wakes the box. It builds the image itself, runs the repository’s checks and keeps the result in its own registry. Nothing leaves the house.",
  },
  {
    group: "shipped",
    time: "0:59",
    title: "It ships with everything",
    text: "An address, a certificate, a sign-in and a database, without asking.",
  },
  {
    group: "back",
    time: "2:00",
    title: "One step takes it back",
    text: "Every change is a commit. If it isn’t right, the machine returns to the one before, and the history keeps both.",
  },
];

export function How() {
  return (
    <section id="how" aria-labelledby="how-title" className="groove py-18 sm:py-24 lg:py-28">
      <div className="wrap">
        <SectionHeader
          id="how-title"
          title="A computer you talk to."
          lead="Say what you need from your phone, wherever you are. A coding agent on one of your machines does the work, and asks before it guesses. Everything it does is written down."
        />

        <div className="grid-12 mt-10 lg:mt-16">
          {/* row 1 is the record's header; the notes take rows 2–5 */}
          <ol className="flex flex-col gap-4 lg:col-span-3 lg:col-start-1 lg:row-span-4 lg:row-start-2 lg:grid lg:grid-rows-subgrid lg:gap-0">
            {STEPS.map((s, i) => (
              <li
                key={s.group}
                className={`relative ${i === 0 ? "lg:pt-5" : "pt-5"} lg:after:absolute lg:after:left-full lg:after:top-14 lg:after:h-px lg:after:w-[calc((100%_-_48px)/3_+_48px)] lg:after:bg-white/10`}
              >
                <p className="t-mono-s">{s.time}</p>
                <h3 className="t-body mt-2 font-medium text-ink-1">{s.title}</h3>
                <p className="t-body mt-1">{s.text}</p>
                <HowRecordCard step={s.group} className="mt-3 lg:hidden" />
              </li>
            ))}
          </ol>
          <HowRecord className="hidden lg:col-span-8 lg:col-start-5 lg:row-span-5 lg:row-start-1 lg:grid lg:grid-rows-subgrid" />
        </div>
      </div>
    </section>
  );
}
