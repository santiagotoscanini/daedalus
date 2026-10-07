import { createFileRoute } from "@tanstack/react-router";

import { Faq } from "~/components/sections/faq";
import { GetIt } from "~/components/sections/get-it";
import { OpenSource } from "~/components/sections/open-source";
import { Universe } from "~/components/universe/universe";
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

/** One argument: the network at work (the hero and three requests), everything it touches (the field
 * the camera pulls back through), the two pieces to get, the questions, and the labyrinth again as the
 * bookend. Each screen of the app appears once, in the network. */

function Landing() {
  return (
    <main id="main">
      <Walk />
      <Universe />
      <GetIt />
      <Faq />
      <OpenSource />
    </main>
  );
}
