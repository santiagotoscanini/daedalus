import { createFileRoute } from "@tanstack/react-router";

import { Faq } from "~/components/sections/faq";
import { GetIt } from "~/components/sections/get-it";
import { OpenSource } from "~/components/sections/open-source";
import { Walk } from "~/components/walk/walk";
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

/** One argument: the network at work (the hero, three requests and what the box takes in),
 * the two pieces to get, the questions, and the labyrinth again as the bookend. Each
 * screen of the app appears once, in the network. */

function Landing() {
  return (
    <main id="main">
      <Walk />
      <div className="divider mx-auto max-w-4xl" aria-hidden />
      <GetIt />
      <Faq />
      <OpenSource />
    </main>
  );
}
