/** Start (#start): the last section, an invitation and then exactly what is true today. Three steps
 * in one column centred on the axis, hairlines between them, each numbered in the margin beside its
 * title, with what it takes now, the ○ line for what is next, and at most one button: the setup
 * notes, the Mac download (the section's one filled button) and, for asking, nothing to click,
 * because asking happens on your phone. Step 2 opens with "Once the box is running", so the bright
 * button never reads as the first thing to do. Its title carries the three systems the app joins,
 * filled and matched by eye rather than by box, the Mac in ink-1 because it is ready and the other
 * two in ink-4 because they are next. No commands anywhere. The close is what daedalus costs
 * (nothing) and what an address for the apps does. */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ComingLine } from "~/components/landing/coming";
import { Header, Section } from "~/components/landing/section";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";
const MAC_DMG = `${REPO}/releases/latest/download/daedalus-agent-macos.dmg`;

/* The Windows mark redrawn on a 13px grid: two squares of 6 with a 1px gap, so every edge lands on a
 * whole device pixel at 1x and 2x. Scaled from the brand path (a gap of 0.7px at this size) the
 * gap was antialiased into one bright and one dim row. The four-square geometry is the same. */
const WINDOWS_13 = "M0 0h6v6H0zM7 0h6v6H7zM0 7h6v6H0zM7 7h6v6H7z";

/** A step's ○ line, in the shared left-aligned form: a second line starts under the words, not
 * under the ring. */
function Next({ children }: { children: ReactNode }) {
  return <ComingLine className="t-caption start-next">{children}</ComingLine>;
}

export function Start() {
  return (
    <Section id="start" end>
      <Header title="Bring your cloud home." intro="daedalus runs one home today. Yours can be the second." />
      <div className="wrap after-header">
        <ol className="start-steps" role="list">
          <li>
            <h3 className="t-step start-title">
              <span className="start-num" aria-hidden>
                1
              </span>
              Start with a computer you already have.
            </h3>
            <p className="start-text">
              An old PC or a small new one becomes the box. Today, setting it up takes someone comfortable with a
              terminal and the setup notes.
            </p>
            <Next>Coming: an installer that takes a few clicks.</Next>
            <div className="start-action">
              <Link to="/docs" hash="box" activeProps={{}} className="btn btn-secondary">
                Read the setup notes
              </Link>
            </div>
          </li>
          <li>
            <h3 className="t-step start-title">
              <span className="start-num" aria-hidden>
                2
              </span>
              Add your other computers.
              {/* the systems it joins: the Mac ready, the others next. Sized by eye, each standing on
                  the title's baseline: the apple at 16 (its leaf rises above the caps, its body is
                  their height), the four solid squares at 13, just under the caps, and Tux at 15,
                  whose narrow head carries little weight above them. */}
              <span className="start-marks" aria-hidden>
                <Mark id="apple" size={16} className="text-ink-1" />
                <svg width={13} height={13} viewBox="0 0 13 13" fill="currentColor" className="text-ink-4">
                  <path d={WINDOWS_13} />
                </svg>
                <Mark id="linux" size={15} className="text-ink-4" />
              </span>
            </h3>
            <p className="start-text">
              Once the box is running, install the daedalus app on each computer, then approve it on the box.
            </p>
            <Next>
              Coming: the same download for Windows and Linux. Until then,{" "}
              <Link to="/docs" hash="computers" activeProps={{}} className="start-link">
                the setup notes
              </Link>{" "}
              install it.
            </Next>
            <div className="start-action">
              <a href={MAC_DMG} className="btn btn-primary">
                <Mark id="apple" size={16} className="start-apple" />
                Download for Mac
              </a>
              <p className="t-caption start-req">macOS 13 or newer</p>
            </div>
          </li>
          <li>
            <h3 className="t-step start-title">
              <span className="start-num" aria-hidden>
                3
              </span>
              Ask for what you need.
            </h3>
            <p className="start-text">
              Today you ask through Claude Code on the box, which comes with a Claude plan from $17 a month. iPhone
              apps also need Apple’s developer account, $99 a year, and are built on GitHub’s Macs for now.
            </p>
            <Next>
              Coming: a conversation anyone in your family can have with the house, and iPhone apps built on your
              own Mac.
            </Next>
          </li>
        </ol>
        {/* one sentence to a line from 640 up; a phone balances the two as one paragraph */}
        <p className="start-close">
          <span className="start-line">
            Free and open source, with no daedalus account and nothing to pay for daedalus itself.
          </span>{" "}
          <span className="start-line">Your apps need a web address of your own, about $10 a year.</span>
        </p>
        <p className="start-repo">
          <a href={REPO} className="link">
            <Mark id="github" size={14} />
            View on GitHub
          </a>
        </p>
      </div>
    </Section>
  );
}
