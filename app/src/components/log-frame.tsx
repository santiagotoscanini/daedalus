// One embedded Grafana log panel: the frame, covered until Grafana has
// finished assembling itself (components/logs.tsx says which panel and why).

import { useEffect, useState } from 'react'

import { cn } from '../lib/cn'
import { Bar } from './skeleton'

/* An embedded Grafana panel. Sized rather than aspect-ratioed: a log view
   wants a fixed number of visible lines, not a shape.

   The WRAPPER owns the height and the border, and the iframe is absolutely
   positioned over the skeleton inside it — so the box is the same size and
   shape throughout, and uncovering it changes nothing but what is inside. */
const EMBED_WRAP =
  'relative h-[22rem] overflow-hidden rounded-[9px] border border-subtle bg-background max-[50rem]:h-[18rem]'
/* Log-shaped: ragged lines of the app's own grey, so the wait looks like the
   rest of the dashboard loading rather than like Grafana loading. */
const EMBED_SKELETON =
  'absolute inset-0 flex flex-col justify-center gap-[0.85rem] px-[1.2rem] py-[1.1rem]'
/* Paints the embedded document's canvas in the page's scheme before Grafana's
   own styles arrive, rather than the browser's default white — the one place
   a utility reaches into content this app does not own. */
const EMBED =
  'absolute inset-0 block h-full w-full border-0 [color-scheme:light] dark:[color-scheme:dark]'
/* Covered until Grafana has finished assembling itself — see LogFrame. The
   animation is the backstop for a page whose JS never runs: zero duration on a
   delay longer than LogFrame's own ceiling, so it only ever fires when both of
   that component's timers failed to, and never races them. The keyframe stays
   in styles.css — a keyframe name is not a class. */
const EMBED_COVERED = 'animate-[embed-reveal_0s_linear_15s_forwards] opacity-0'
const EMBED_READY = 'animate-none opacity-100 [transition:opacity_0.2s_ease]'

/**
 * The ceiling, for when `load` never arrives at all — Grafana down, the
 * session missing, the network gone. The frame is uncovered regardless so
 * whatever Grafana IS showing (a login screen, an error) becomes visible and
 * can be acted on. A cover that outlives its content is just a hidden fault.
 *
 * Comfortably above the largest `settle` so it never pre-empts a frame that
 * is merely being patient.
 */
const REVEAL_CAP_MS = 10_000

/**
 * The frame, covered until Grafana has finished assembling itself.
 *
 * `load` fires when the embedded DOCUMENT is done, which is the START of
 * Grafana's boot, not the end of it. What follows is four visible states —
 * empty panel, a centred "Loading ..." spinner, empty panel again with only
 * the "Powered by Grafana" badge, then the rows. Revealing on `load` would
 * uncover the frame just in time to show all of it, so the cover is held for
 * `settle` milliseconds longer.
 *
 * That number is a guess and cannot be anything else: the frame is
 * cross-origin, d-solo sends no postMessage, and there is no other signal to
 * wait on. But it is a guess that only has to hold ONCE per mount, because
 * with no `refresh` the panel never renders a second time. If it is short,
 * the cost is bounded — the cover lifts a beat early and you see the tail of
 * Grafana's boot.
 *
 * The cover has to be in the SERVER-rendered markup: the browser begins
 * fetching the iframe the instant that HTML lands, well before React
 * hydrates, so nothing done on mount can get in front of the first paint.
 * That means a page whose JS never runs would keep the frame hidden forever,
 * so the reveal also has a pure-CSS backstop on a longer timer — see
 * `EMBED_COVERED`.
 */
export function LogFrame({ src, title, settle }: { src: string; title: string; settle: number }) {
  const [loaded, setLoaded] = useState(false)
  const [ready, setReady] = useState(false)

  // Two independent timers, because they answer different questions: one
  // waits out Grafana's boot after a successful load, the other gives up on
  // waiting at all.
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => {
      setReady(true)
    }, settle)
    return () => {
      clearTimeout(t)
    }
  }, [loaded, settle])

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true)
    }, REVEAL_CAP_MS)
    return () => {
      clearTimeout(t)
    }
  }, [])

  return (
    <div className={EMBED_WRAP}>
      {!ready && (
        <div className={EMBED_SKELETON} aria-hidden="true">
          <Bar w="26%" h={10} />
          <Bar w="88%" h={10} />
          <Bar w="71%" h={10} />
          <Bar w="93%" h={10} />
          <Bar w="62%" h={10} />
          <Bar w="80%" h={10} />
        </div>
      )}
      {/* Eager, despite sitting below the fold. `loading="lazy"` starts the
          fetch as the box scrolls into view, which puts Grafana's boot — and
          so this cover — directly under the eye at the moment you arrive.
          Fetching with the page means the wait is spent while you are reading
          something else. */}
      <iframe
        className={cn(EMBED, ready ? EMBED_READY : EMBED_COVERED)}
        src={src}
        title={title}
        onLoad={() => {
          setLoaded(true)
        }}
      />
    </div>
  )
}
