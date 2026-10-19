import { createFileRoute } from "@tanstack/react-router";

import { Cost } from "~/components/sections/cost";
import { Decisions } from "~/components/sections/decisions";
import { Hero } from "~/components/sections/hero";
import { Kitchen } from "~/components/sections/kitchen";
import { Made } from "~/components/sections/made";
import { RunsItself } from "~/components/sections/runs-itself";
import { Start } from "~/components/sections/start";
import { Vercel } from "~/components/sections/vercel";
import { pageHead } from "~/site-head";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () =>
    pageHead({
      path: "",
      title: "daedalus: your own cloud, at home",
      description:
        "daedalus turns a computer in your house into your family’s private cloud. Ask for an app from your phone, and it builds the app and keeps watch over it.",
    }),
});

/** One argument, one centred axis, in the order a person meets it: you ask your house for an app
 * and it arrives on Grandma's phone; the apps no company would make; every hard decision already
 * made; where it lives; what it costs against renting; how it looks after itself; where it goes
 * next; how to start. Read only the headings in order and the argument still holds. */
function Landing() {
  return (
    <main id="main">
      <Hero />
      <Made />
      <Decisions />
      <Kitchen />
      <Cost />
      <RunsItself />
      <Vercel />
      <Start />
    </main>
  );
}
