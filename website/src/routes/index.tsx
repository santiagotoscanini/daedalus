import { createFileRoute } from "@tanstack/react-router";
import { Hero } from "~/components/hero/hero";
import { ApplyFlow } from "~/components/sections/apply-flow";
import { Faq } from "~/components/sections/faq";
import { GetIt } from "~/components/sections/get-it";
import { OpenSource } from "~/components/sections/open-source";
import { RentedCloud } from "~/components/sections/rented-cloud";
import { pageHead } from "~/site-head";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () =>
    pageHead({
      path: "",
      title: "Daedalus. Build yourself a cloud.",
      description:
        "An open-source control plane for one machine you own: push-to-deploy, managed Postgres, single sign-on, certificates, monitoring and backups, on NixOS.",
    }),
});

/** One argument in six parts: the product (hero, with the app itself under
 * the fold), the receipt that is the idea, the Apply bar that is how it
 * works, the two pieces to get, the questions, and the labyrinth again as
 * the bookend. Each screen of the app appears once, in the hero. */
function Landing() {
  return (
    <main id="main">
      <Hero />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <RentedCloud />
      <ApplyFlow />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <GetIt />
      <Faq />
      <OpenSource />
    </main>
  );
}
