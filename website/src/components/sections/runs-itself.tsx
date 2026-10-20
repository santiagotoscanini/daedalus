/** He's right, so the box runs itself. Moxie Marlinspike's line opens the section with both
 * quote marks hung outside the words, so the words of each line centre on the axis; then the answer:
 * nobody in the house has to look after the box. The figure shows at once: the box's record as a calm product
 * card, its three most recent changes one line each (the app, what changed, who asked and when),
 * the last one an attempt that never went live.
 *
 * A switch, "Show what it did", opens the newest entry, the change that added Pinch, into its full
 * record: the commit, the diff to the one file every app is written in, the machine and the app
 * being built, the iPhone build, and an Undo that puts the house back the way it was. Undone, the
 * whole entry says so: its header greys like the attempt below it and reads "You undid this just
 * now", the machine row goes back a generation, and the checks and the diff lose their green. The switch is
 * a native checkbox before the card in the DOM, and `:checked ~` opens the record (and the caption
 * under the card), so it works without script; script only marks the closed record `inert` and
 * runs Undo and Redo (without it the Undo button renders and does nothing). The card is a picture
 * of the product, so its type is product type, set in runs-itself.css. */

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { CheckIcon } from "~/components/icons";
import { type AppId, AppIcon } from "~/components/landing/app-icon";
import { Header, Section } from "~/components/landing/section";
import { Mark } from "~/components/marks";

/** The change, as the agent wrote it into site/apps.json (the real file's shape). */
const DIFF = [
  `"pinch": {`,
  `  "stage": "live",`,
  `  "postgres": true,`,
  `  "storage": true,`,
  `  "litellm": true,`,
  `  "auth": { "mode": "native", "healthPath": "/api/healthz" },`,
  `  "presentation": { "description": "The family's recipes" }`,
  `},`,
];

/** The app's build, from the push to the live check. Illustrative timings. */
const STEPS = [
  { at: "0.0s", step: "webhook", detail: "push to main" },
  { at: "0.4s", step: "plan", detail: "node 24, pnpm, railpack" },
  { at: "38.2s", step: "build", detail: "image built on the box" },
  { at: "39.6s", step: "push", detail: "the box’s own registry" },
  { at: "45.1s", step: "deploy", detail: "pinch.riveras.com, health check 200" },
];

/** The two older entries under Pinch's, newest first. The last one is the claim in the prose made
 * visible: a change that did not build never went live. */
const EARLIER: { app: AppId; title: string; when: string; failed?: boolean }[] = [
  { app: "pillbox", title: "Remind Dad at nine, not eight", when: "You asked yesterday" },
  {
    app: "pillbox",
    title: "Tried: Pillbox on the Apple Watch. It didn’t build, so it never went live.",
    when: "You asked last week",
    failed: true,
  },
];

const UNDONE = "Back to how it was before Pinch. Both versions stay in the history.";

/** A line of the record that says something else once the change is undone: the one shown fades in
 * as the other fades out, and both share the cell so the line never changes size. */
function Flip({ on, from, to }: { on: boolean; from: ReactNode; to: ReactNode }) {
  return (
    <span className="rc-flip">
      <span data-on={on ? undefined : ""} aria-hidden={on || undefined}>
        {from}
      </span>
      <span data-on={on ? "" : undefined} aria-hidden={on ? undefined : true}>
        {to}
      </span>
    </span>
  );
}

/** Rows of the record fade in one after another when it opens: `--i` is the row's place. */
const nth = (i: number) => ({ "--i": i }) as CSSProperties;

export function RunsItself() {
  const [open, setOpen] = useState(false);
  /** Set once hydrated: only then is the closed record marked inert (without script the closed
   * record is hidden by CSS alone, and opening it must leave it readable). */
  const [live, setLive] = useState(false);
  const [undone, setUndone] = useState(false);
  const toggle = useRef<HTMLInputElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const redo = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the next Undo or Redo renders. */
  const focusNext = useRef<"undo" | "redo" | null>(null);

  useEffect(() => {
    // a restored page may come back with the box already ticked
    setOpen(Boolean(toggle.current?.checked));
    setLive(true);
  }, []);

  useEffect(() => {
    const to = focusNext.current;
    focusNext.current = null;
    if (to === "redo") redo.current?.focus();
    if (to === "undo") undo.current?.focus();
  }, [undone]);

  const flip = (to: boolean) => {
    focusNext.current = to ? "redo" : "undo";
    setUndone(to);
  };

  return (
    <Section id="runs-itself">
      <div className="wrap">
        <figure className="ri-quote">
          <blockquote>
            <p className="t-quote">
              <span className="ri-hang">
                <span>“</span>
              </span>
              People don’t want to run <span className="whitespace-nowrap">their own servers,</span> and{" "}
              <span className="whitespace-nowrap">
                never will.
                <span className="ri-hang-end">
                  <span>”</span>
                </span>
              </span>
            </p>
          </blockquote>
          <figcaption className="t-caption mt-4 text-center">
            <cite className="not-italic">Moxie Marlinspike, creator of Signal, 2022</cite>
          </figcaption>
        </figure>
      </div>

      <Header
        className="mt-12"
        title={
          <>
            <span className="ri-sentence">He’s right.</span> <span className="ri-sentence">So the box runs itself.</span>
          </>
        }
        intro="Once it’s set up, it watches itself, and tells you if it ever needs you."
        prose={"Before the box changes anything, it writes down what changed, why and who asked. A change that doesn’t build never goes live, and any change can be undone in one step, even\u00a0weeks\u00a0later."}
      />

      <div className="wrap ri-figure">
        <input
          ref={toggle}
          type="checkbox"
          role="switch"
          id="record-switch"
          className="record-switch"
          autoComplete="off"
          aria-describedby="record-hint"
          aria-controls="ri-record"
          onChange={(e) => setOpen(e.currentTarget.checked)}
        />
        <span className="ri-words">
          <label htmlFor="record-switch" className="ri-label">
            Show what it did
          </label>
          <span id="record-hint" className="t-caption ri-hint">
            You never need to look. It’s here if you’re curious.
          </span>
        </span>

        <div className="fragment lifted rc-card" data-undone={undone ? "" : undefined}>
          <ol className="rc-list">
            <li className="rc-entry rc-pinch">
              <div className="rc-top">
                <AppIcon app="pinch" size={20} />
                <p className="rc-title">Add Pinch, the family’s recipes</p>
                <p className="rc-when tnum">
                  <Flip on={undone} from="You asked 2 min ago" to="You undid this just now" />
                </p>
              </div>

              <div className="ri-fold">
                <div id="ri-record" className="ri-fold-in" inert={live && !open ? true : undefined}>
                  <p className="rc-by ri-row" style={nth(0)}>
                    written by the coding agent from your request, <span className="rc-hash">4f2a91c</span>
                  </p>
                  <p className="rc-file ri-row" style={nth(1)}>
                    site/apps.json
                  </p>
                  <div className="rc-diff ri-row" style={nth(2)}>
                    <pre className="rc-lines t-code">
                      {DIFF.map((line) => (
                        <span key={line} className="rc-line">
                          <span className="rc-plus" aria-hidden>
                            +
                          </span>
                          <span className="rc-code">{line}</span>
                        </span>
                      ))}
                    </pre>
                  </div>

                  <dl className="rc-rows">
                    <div className="rc-row ri-row" style={nth(3)}>
                      <dt>Machine</dt>
                      <dd className="rc-item">
                        <span className="rc-icon rc-ok">
                          <CheckIcon size={12} />
                        </span>
                        <Flip
                          on={undone}
                          from="NixOS generation 412, switched after its checks passed"
                          to="Back to NixOS generation 411, switched after its checks passed"
                        />
                      </dd>
                    </div>
                    <div className="rc-row rc-app ri-row" style={nth(4)}>
                      <dt>App</dt>
                      <dd>
                        <ol className="rc-steps">
                          {STEPS.map((s) => (
                            <li key={s.step} className="rc-step">
                              <span className="rc-icon rc-ok">
                                <CheckIcon size={12} />
                              </span>
                              <span className="rc-name">{s.step}</span>
                              <span className="rc-detail">{s.detail}</span>
                              <span className="rc-time tnum">{s.at}</span>
                            </li>
                          ))}
                        </ol>
                      </dd>
                    </div>
                    <div className="rc-row ri-row" style={nth(5)}>
                      <dt>iPhone app</dt>
                      <dd className="rc-item">
                        <span className="rc-icon rc-apple">
                          <Mark id="apple" size={12} />
                        </span>
                        built on GitHub’s Macs, sent to 5 iPhones through TestFlight
                      </dd>
                    </div>
                  </dl>

                  <div className="rc-foot ri-row" style={nth(6)}>
                    <div className="rc-swap" data-on={undone ? undefined : ""}>
                      <button
                        ref={undo}
                        type="button"
                        className="btn btn-secondary btn-sm"
                        tabIndex={undone ? -1 : undefined}
                        aria-hidden={undone || undefined}
                        onClick={() => flip(true)}
                      >
                        Undo this change
                      </button>
                    </div>
                    <p className="rc-swap rc-undone" data-on={undone ? "" : undefined} aria-hidden={undone ? undefined : true}>
                      {UNDONE}{" "}
                      <button
                        ref={redo}
                        type="button"
                        className="link rc-redo"
                        tabIndex={undone ? undefined : -1}
                        onClick={() => flip(false)}
                      >
                        Redo
                      </button>
                    </p>
                    <p className="sr-only" aria-live="polite">
                      {undone ? UNDONE : ""}
                    </p>
                  </div>
                </div>
              </div>
            </li>

            {EARLIER.map((e) => (
              <li key={e.title} className="rc-entry" data-failed={e.failed ? "" : undefined}>
                <div className="rc-top">
                  <AppIcon app={e.app} size={20} />
                  <p className="rc-title">{e.title}</p>
                  <p className="rc-when">{e.when}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="ri-fold ri-under-fold">
          <div className="ri-fold-in">
            <p className="ri-under">
              Under the hood, the box runs NixOS: the whole machine is a set of files in a&nbsp;git&nbsp;repository, so those
              files and a copy of your data turn a new box into your old one.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
