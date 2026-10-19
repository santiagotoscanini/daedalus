import { createFileRoute } from "@tanstack/react-router";
import { NotFound } from "~/components/not-found";

/** /404.html: the file GitHub Pages serves for any address the site does not have. The same page as
 * the root's notFoundComponent, prerendered once so Pages has something of ours to serve. It is
 * never indexed and names no canonical: it stands in for whatever address was asked for. */
export const Route = createFileRoute("/404.html")({
  component: NotFound,
  head: () => ({
    meta: [{ title: "daedalus: nothing lives here" }, { name: "robots", content: "noindex" }],
  }),
});
