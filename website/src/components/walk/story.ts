import type { NodeId } from "./geo";

/** The three requests the page runs through the network, and where in the
 * scroll each step happens. One list, read by the scene (what lights), the
 * captions (what is said) and the plain list reduced motion and the
 * prerender get. Every sentence is checked against the engine's docs:
 * ARCHITECTURE.md ("The other machines"), agent/README.md, BUILDS.md. */

export interface Step {
  id: string;
  request: string;
  kicker: string;
  text: string;
  /** scroll window the caption holds in: [in, out] */
  f: [number, number];
  /** what the caption is anchored to: a node, or the middle of a link */
  at: { node: NodeId } | { link: string } | { app: true };
}

export const STEPS: Step[] = [
  {
    id: "ai-1",
    request: "An AI query",
    kicker: "01 · An AI query",
    text: "A query reaches the gateway on the box.",
    f: [0.1, 0.165],
    at: { node: "net" },
  },
  {
    id: "ai-2",
    request: "An AI query",
    kicker: "01 · An AI query",
    text: "It is routed to the model server on the gaming PC. The agent there reads that provider and reports it up its pinned link; daedalus keeps the gateway's routes in step.",
    f: [0.165, 0.245],
    at: { link: "pc" },
  },
  {
    id: "ai-3",
    request: "An AI query",
    kicker: "01 · An AI query",
    text: "The tokens stream back the way the request came.",
    f: [0.245, 0.32],
    at: { node: "pc" },
  },
  {
    id: "cl-1",
    request: "A Claude session",
    kicker: "02 · A Claude session",
    text: "An admin turns remote control on for a machine in Settings. The box sends that policy down the machine's pinned link.",
    f: [0.35, 0.43],
    at: { link: "pc2" },
  },
  {
    id: "cl-2",
    request: "A Claude session",
    kicker: "02 · A Claude session",
    text: "The agent runs Claude Code's remote control there, as a job of the OS. You steer the session from wherever you use Claude, and the box lists it on its Claude page.",
    f: [0.43, 0.53],
    at: { node: "pc2" },
  },
  {
    id: "gh-1",
    request: "A push to main",
    kicker: "03 · A push to main",
    text: "The GitHub App tells the box. The webhook is verified before anything is believed.",
    f: [0.56, 0.625],
    at: { node: "github" },
  },
  {
    id: "gh-2",
    request: "A push to main",
    kicker: "03 · A push to main",
    text: "The box builds the image itself with Railpack and runs the repo's own checks inside the build.",
    f: [0.625, 0.7],
    at: { node: "box" },
  },
  {
    id: "gh-3",
    request: "A push to main",
    kicker: "03 · A push to main",
    text: "The image goes to the box's own registry, and the app restarts on it. The outcome goes back to GitHub as a check run.",
    f: [0.7, 0.8],
    at: { app: true },
  },
];

/** The real screens that pop out as inspectors, and from what. */
export const INSPECTORS: Array<{ view: "updates" | "deploys" | "apps"; f: [number, number]; from: NodeId | "app" }> = [
  { view: "updates", f: [0.17, 0.3], from: "pc" },
  { view: "deploys", f: [0.585, 0.71], from: "box" },
  { view: "apps", f: [0.725, 0.81], from: "app" },
];

/** Timeline of what lights, for the scene. */
export const T = {
  idle: [0, 0.08],
  aiIn: [0.1, 0.165],
  aiRoute: [0.165, 0.245],
  aiBack: [0.245, 0.32],
  clDown: [0.35, 0.43],
  clUp: [0.45, 0.53],
  ghIn: [0.56, 0.625],
  build: [0.625, 0.7],
  deploy: [0.7, 0.76],
  land: [0.76, 0.8],
} as const;
