// Visual primitives for the module pages.
//
// All hand-rolled SVG and CSS, no charting library: a chart dependency would
// be the largest thing in node_modules by an order of magnitude, and a host in
// dev mode (`fleet.daedalus.source = "dev"`) serves the app through Vite, so
// every byte here is parsed on a cold page load.
//
// Two rules every component below follows:
//
//   Absent data renders as absent, never as zero. A ring at 0% and a ring
//   with no reading look identical if you draw them the same way, and on a
//   page fed by thirty services the difference is the whole point.
//
//   Motion means something is happening. Nothing here animates on a timer for
//   decoration: a bar shimmers while a download is actually moving, a dot
//   pulses while a stream is actually playing. Idle content sits still, so
//   movement in the corner of your eye is always worth looking at.
//
// Every primitive that takes a `tone` arms `--tone` on its own root with
// `toneStyle()` and its parts read it back — see lib/tone.ts for why that is a
// variable rather than a class per family per tone.

export type { Tone } from '../../lib/tone'
export * from './board'
export * from './charts'
export * from './stats'
