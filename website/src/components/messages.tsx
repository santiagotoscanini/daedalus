import { ARRIVE, RUNS, at } from "~/components/demo/views/apps-view";
import { ArrowUp, Terminal } from "~/components/icons";

/** The hero's conversation: a request sent from a phone to a coding agent on the box, and its
 * answers, timed against the table beside it (ARRIVE and RUNS in apps-view.tsx): the reply that
 * starts the work lands just before the row arrives, the one that says it is live just after the
 * row runs. A desktop messages window drawn in the page's own surfaces, never a phone: the header
 * line says where the request came from.
 *
 * The request is drawn from the first frame, so the window opens mid-conversation and never sits
 * empty while the hero waits for fonts and for the shot to come on screen. The sequence starts at
 * the typing dots. The body has a fixed height, so nothing below it moves while the replies grow.
 * Reduced motion and no-script land on the last frame, where the typing dots are gone. */

// Seconds after play. Rounded, so the CSS reads 1.4s and not 1.4000000000000001s.
const t = (s: number) => Math.round(s * 100) / 100;
const TYPING = 0.3;
const STARTED = t(ARRIVE - 0.2);
const LIVE = t(RUNS + 0.2);

export function Messages({ className = "" }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="A conversation with a coding agent on the box, sent from a phone: a page with the store's hours is asked for, built and live."
      className={`window flex h-[248px] flex-col ${className}`}
    >
      {/* 48px, like the body's 8px top and 6px gap: the window hangs under the almacen row, which
          is 59px tall, and at 1440×900 this is what keeps the last reply above the fold */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-edge-1 px-4">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raise-3 text-ink-3">
          <Terminal size={12} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="t-small font-medium text-ink-1">a coding agent on the box</span>
          <span className="t-small text-ink-4">from your phone</span>
        </span>
        <span className="t-small tnum shrink-0 text-ink-4">Today 18:02</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-4 pt-2">
        {/* 88%, not 84: the request is 291px wide set on one line, and 84% of the 342px body
            would wrap it */}
        <p className="t-small max-w-[88%] shrink-0 self-end rounded-[14px] rounded-br-chip bg-raise-3 px-3 py-2 text-ink-1 shadow-[inset_0_0_0_1px_var(--color-edge-1)]">
          My mom needs a page with the store’s hours.
        </p>
        {/* -mb-1.5 takes back the column gap, so once the dots are gone the reply sits 6px under
            the request, not 12 */}
        <div className="seq-life -mb-1.5 shrink-0 self-start" style={{ ...at(TYPING), ["--for" as string]: `${t(STARTED - TYPING)}s` }} aria-hidden>
          <span className="flex h-5 items-center gap-[3px]">
            <span className="size-1 rounded-full bg-ink-4" />
            <span className="size-1 rounded-full bg-ink-4" />
            <span className="size-1 rounded-full bg-ink-4" />
          </span>
        </div>
        {/* Wrapped greedily, the way a chat client wraps (the page's p rule is pretty). The 240px
            measure breaks the last reply at its sentence: across 92% of the body it broke before
            "step.", and balanced it read as typeset. */}
        <div className="seq-grow shrink-0 self-start" style={at(STARTED)}>
          <p className="t-small text-ink-2 [text-wrap:wrap]">Writing it down and building it on the box.</p>
        </div>
        <div className="seq-grow max-w-60 shrink-0 self-start" style={at(LIVE)}>
          <p className="t-small text-ink-2 [text-wrap:wrap]">It’s live, with a sign-in and a database. Undo is one step.</p>
        </div>
      </div>

      <div className="mx-3 mb-3 flex h-9 shrink-0 items-center rounded-full pl-[14px] pr-1.5 shadow-[inset_0_0_0_1px_var(--color-edge-2)]">
        <span className="t-small flex-1 text-ink-4">Message</span>
        <span className="flex size-6 items-center justify-center rounded-full bg-raise-3 text-ink-2">
          <ArrowUp size={12} />
        </span>
      </div>
    </div>
  );
}
