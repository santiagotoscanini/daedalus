import type { DemoView } from "~/components/demo/demo-window";

/** The four feature rows, each a real page of the app rebuilt by hand as
 * a demo window. `color` is the status color the row's kicker lights up
 * in; `view` names the demo view rendered beside the copy. */
export interface Feature {
  id: string;
  view: DemoView;
  kicker: string;
  title: string;
  body: string;
  color: string;
}

export const FEATURES: Feature[] = [
  {
    id: "fleet",
    view: "fleet",
    kicker: "the fleet",
    title: "Every app, one honest list.",
    body: "Every app with its status, hostname, exposure and traffic, and whatever needs attention sorted into view. Change a setting and it queues in the Apply bar. Nothing lands until the whole change becomes a commit.",
    color: "#e2795a",
  },
  {
    id: "deploys",
    view: "deploys",
    kicker: "deploys",
    title: "Push to main. Live in minutes.",
    body: "Apps build on the box's own CI runners, land in its own registry, and deploy the moment the digest moves. No cloud in the loop. The pipeline never leaves the house.",
    color: "#4ea87a",
  },
  {
    id: "monitoring",
    view: "monitoring",
    kicker: "monitoring",
    title: "Honest by construction.",
    body: "Every panel distinguishes “no” from “couldn't ask”. A dead probe renders as unknown, never as healthy, and a stale snapshot counts as absent.",
    color: "#d9a441",
  },
  {
    id: "updates",
    view: "updates",
    kicker: "updates",
    title: "Updates are decisions, not surprises.",
    body: "Every container is pinned by digest. Daedalus shows what moved and what the changelog says, then updates one thing at a time: commit, rebuild, verify, and revert if it doesn't come back.",
    color: "#4493f8",
  },
];
