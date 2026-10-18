import { Link } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { DemoWindow } from "~/components/demo/demo-window";
import { RUNS } from "~/components/demo/views/apps-view";
import { Logo } from "~/components/logo";
import { Mark } from "~/components/marks";

const REPO = "https://github.com/santiagotoscanini/daedalus";

/** The hero: the mission in one line, then the product doing it.
 *
 * The picture is the control plane's Apps page (a hand-built redraw of the real one) with a phone
 * in front of it. On the phone, a request goes to a coding agent on the box; in the table, the app
 * it asked for arrives at the top, building, then running. That is how the reference box is driven
 * today. The sequence is CSS with delays, so the prerendered page plays it before any script runs,
 * and reduced motion shows the finished frame. */

const at = (s: number): CSSProperties => ({ ["--at" as string]: `${s}s` });

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="stage-grid pointer-events-none absolute inset-x-0 top-0 h-[44rem]" aria-hidden />
      <div className="relative px-6 pt-36 text-center sm:pt-44">
        <a href="#made" className="rise pill">
          <b>Open source</b>
          Running one house today
          <span aria-hidden className="text-muted">
            →
          </span>
        </a>
        <h1 className="rise h-display mx-auto mt-7 max-w-[56rem] text-[clamp(2.9rem,7.4vw,5.6rem)]">
          Software, made for one.
        </h1>
        <p className="rise rise-1 lede mx-auto mt-6 max-w-[40rem] sm:text-[1.2rem]">
          daedalus turns the computers you already own into a cloud you can talk to. Say what you need, and it
          writes the change down, builds it and ships it. Every change can be undone in one step.
        </p>
        <div className="rise rise-2 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/" hash="get" className="btn btn-primary">
            Get started
          </Link>
          <a href={REPO} className="btn btn-ghost">
            <Mark id="github" size={16} />
            View on GitHub
          </a>
        </div>
      </div>

      <div className="rise rise-3 relative mx-auto mt-16 max-w-[70rem] px-4 sm:mt-20 sm:px-6">
        <div className="hero-shot relative">
          <DemoWindow />
          <div className="absolute -bottom-12 -left-3 hidden md:block lg:-left-12">
            <Phone />
          </div>
        </div>
        <div className="mt-8 flex justify-center md:hidden">
          <Phone />
        </div>
      </div>
      <div className="h-24 sm:h-32" />
    </section>
  );
}

/** The phone the request is sent from: a conversation with a coding agent on the box. */
function Phone() {
  return (
    <div className="phone" role="img" aria-label="A phone: someone asks for a page with their mom's store hours, and the house answers that it is live with a sign-in and a database.">
      <div className="phone-screen">
        <div className="phone-head">
          <Logo size={26} />
          <div className="text-left">
            <p className="text-[13px] font-semibold leading-tight">Your house</p>
            <p className="text-[11px] leading-tight text-muted">a coding agent on the box</p>
          </div>
        </div>
        <div className="phone-msgs">
          <div className="msg-wrap seq-grow" style={at(0.9)}>
            <p className="bubble bubble-you">My mom needs a page with the store’s hours.</p>
          </div>
          <div className="msg-wrap seq-life" style={{ ...at(1.6), ["--for" as string]: "1s" }} aria-hidden>
            <span className="bubble bubble-house typing">
              <i />
              <i />
              <i />
            </span>
          </div>
          <div className="msg-wrap seq-grow" style={at(2.6)}>
            <p className="bubble bubble-house">Writing it down and building it on the box.</p>
          </div>
          <div className="msg-wrap seq-grow" style={at(RUNS + 0.2)}>
            <p className="bubble bubble-house">
              It’s live at <span className="font-mono text-[0.74rem]">almacen.toscanini.me</span>, with a
              sign-in and a database. Undo is one step.
            </p>
          </div>
        </div>
        <div className="phone-input">Message</div>
      </div>
    </div>
  );
}
