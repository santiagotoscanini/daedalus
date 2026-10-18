/** The header of Made on it, How, Decisions and Why at home. From 1024px the H2 holds columns 1–6
 * and the lead columns 7–12 with their cap heights level: at 48/52 against 20/30, the lead's 1px of
 * top padding puts its cap top on the H2's (measured; 8px left it 7px low, which read as an
 * accident). Below 1024px they stack. A lead is at most two lines at 1440, about 115 characters in
 * its 588px: four sections in a row open with this header, and a third line of grey at lead size
 * is what makes the run read as generated copy. `title` is a string, so a heading cannot be handed
 * a muted second tone: the Statement answer is the page's only two-tone run. `id` belongs to the
 * heading (the section's aria-labelledby), not to the section. */
export function SectionHeader({ id, title, lead }: { id: string; title: string; lead?: string }) {
  return (
    <div className="grid-12 items-start">
      <h2 id={id} className="t-display max-w-[560px] lg:col-span-6">
        {title}
      </h2>
      {lead ? <p className="t-lead mt-4 max-w-[588px] lg:col-span-6 lg:col-start-7 lg:mt-0 lg:pt-px">{lead}</p> : null}
    </div>
  );
}
