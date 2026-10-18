/** The hero's coda: the objection every self-hosting project meets, quoted small as the set-up, and
 * the answer the whole project rests on at display size. No groove above it, and it holds the
 * page's only two-tone run. The quote's opening mark hangs (the negative indent), so its letters
 * start on the column edge with the rest of the page. Below 640px the set-up clause is its own
 * block: balanced as one run, the phone set changed colour mid-line and left a short fourth line;
 * as two blocks each half balances alone and the colour changes at a line break, as at 1440. */
export function Statement() {
  return (
    <section aria-label="The objection, and the answer" className="pt-18 pb-20 sm:pt-24 sm:pb-28 lg:pt-30 lg:pb-32">
      <div className="wrap">
        <figure className="lg:max-w-[792px]">
          <blockquote className="t-quote" style={{ textIndent: "-0.42em" }}>
            “People don’t want to run their own servers, and never will.”
          </blockquote>
          <figcaption className="t-small mt-3 text-ink-4">Moxie Marlinspike, 2022</figcaption>
        </figure>
        <p className="t-display mt-8 text-balance sm:mt-12 lg:max-w-[1098px]">
          <span className="text-ink-4 max-sm:block">If talking is the only interface you need,</span> running your own
          computer stops being a skill.
        </p>
      </div>
    </section>
  );
}
