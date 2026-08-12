/** The four feature rows, each mapped to a view of the app. `color` is the
 * status color the row's kicker lights up in; `view` names the mock (and the
 * window caption) in screenshot-frame.tsx. */
export interface Feature {
  id: string;
  view: string;
  title: string;
  body: string;
  color: string;
}

export const FEATURES: Feature[] = [
  {
    id: "deploys",
    view: "deploys",
    title: "Push to main. Live in minutes.",
    body: "Apps build on the box's own CI runners, land in its own registry, and deploy the moment the digest moves. No cloud in the loop — the pipeline never leaves the house.",
    color: "#4ea87a",
  },
  {
    id: "monitoring",
    view: "monitoring",
    title: "Honest by construction.",
    body: "Every panel distinguishes “no” from “couldn't ask”. A dead probe renders as unknown, never as healthy; a stale snapshot is treated as absent, never served as current.",
    color: "#d9a441",
  },
  {
    id: "isolation",
    view: "isolation",
    title: "Zero host privilege.",
    body: "Daedalus runs in a rootless container and talks to the machine through file-drop bridges watched by systemd. It can't rebuild, restart or read anything the host didn't explicitly hand it.",
    color: "#4493f8",
  },
  {
    id: "recovery",
    view: "recovery",
    title: "Lose the box, keep the system.",
    body: "Every container, route, dashboard and alert is declared in the repo; secrets ride sops-encrypted in-tree. A fresh checkout plus one key rebuilds the exact machine.",
    color: "#e2795a",
  },
];
