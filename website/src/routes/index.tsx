import { createFileRoute } from "@tanstack/react-router";

import { Anywhere } from "~/components/sections/anywhere";
import { Decisions } from "~/components/sections/decisions";
import { Faq } from "~/components/sections/faq";
import { GetIt } from "~/components/sections/get-it";
import { Hero } from "~/components/sections/hero";
import { House } from "~/components/sections/house";
import { How } from "~/components/sections/how";
import { Showcase } from "~/components/sections/showcase";
import { Statement } from "~/components/sections/statement";
import { pageHead } from "~/site-head";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () =>
    pageHead({
      path: "",
      title: "daedalus: software, made for one",
      description:
        "Open source. daedalus turns the computers you own into a cloud you can talk to: it writes each change down, builds it, and can undo it in one step.",
    }),
});

/** One argument, in the order a person meets it: the mission and the product doing it, with the
 * objection and its answer as the hero's coda; what has been made this way and for whom; one
 * request, start to finish; the decisions already made; why the house; where it is going; the
 * questions; then the close, on the band the footer continues. */

function Landing() {
  return (
    <main id="main">
      <Hero />
      <Statement />
      <Showcase />
      <How />
      <Decisions />
      <House />
      <Anywhere />
      <Faq />
      <GetIt />
    </main>
  );
}
