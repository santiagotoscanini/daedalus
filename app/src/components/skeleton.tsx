import { cn } from '../lib/cn'
import { APP_LIST } from '../routes/apps.index'
import { FIRST_STEP_HEAD, WIZARD, WIZARD_STEP } from '../routes/apps.new'
import {
  PICKER_BOX,
  PICKER_COUNT,
  PICKER_HEAD,
  PICKER_HINT,
  PICKER_SEARCH,
  REPO_LIST,
  REPO_OPT,
  REPO_ROW,
} from './apps/repo-picker'
import { SVC_HEAD, SVC_LOGO } from './service-head'
import {
  BIG_STAT,
  BOARD,
  BOARD_BODY,
  BOARD_GRID,
  BOARD_HEAD,
  STAT,
  STAT_BAND,
  STAT_STRIP,
} from './viz'

// Placeholders for content that has not arrived yet.
//
// Every page here is a fan-out across a dozen services, and the loader used to
// hold the whole navigation until the slowest one answered. Now the shell
// renders immediately and each region streams in behind one of these, so a
// click always produces a page.
//
// Three rules:
//
//   A skeleton occupies the SHAPE the real thing will take. If the panel is
//   four stat cards over a 12-column grid, so is its placeholder — otherwise
//   the page jumps when data lands, which is worse than a blank wait because
//   you have already started reading.
//
//   It never shows a plausible value. No zeroes, no dashes, no "loading…" in a
//   slot that will hold a number: grey blocks only. A dashboard whose empty
//   state is indistinguishable from a real reading is the one bug none of this
//   is allowed to have.
//
//   The shimmer is the only unconditional animation in the app. Everything
//   else here moves because something is happening; this moves because nothing
//   has happened yet, which is exactly what it needs to say.
//
// Every box below is IMPORTED from the file that owns the real component (the
// UPPER_CASE constants above), never restated: a restated box is a box that
// drifts, and the first rule is only true while the two strings are one.

// The sweep, and the one place it is spelled. `@keyframes sk-sweep` still lives
// in styles.css — a keyframes name is not a class, so it survives the rules
// this file used to name.
const SWEEP = 'animate-[sk-sweep_1.35s_ease-in-out_infinite] motion-reduce:animate-none'

// One grey block's own look, so `Bar` and the boxes that borrow it agree.
const SK = cn(
  'block rounded-[5px]',
  'bg-[image:linear-gradient(90deg,var(--panel-2)_0%,var(--raise)_50%,var(--panel-2)_100%)] bg-[length:220%_100%]',
  SWEEP,
)

/** One grey block. `w` is any CSS length — a percentage reads best in a grid. */
export function Bar({ w = '100%', h = 12 }: { w?: string; h?: number }) {
  return <span className={SK} style={{ width: w, height: h }} />
}

/**
 * The service header: artwork, name, version, lede, and the button.
 *
 * Reserved rather than left to arrive, for the first rule above. Nearly every
 * tab on this dashboard opens with a `ServiceHead`, and without a placeholder
 * the whole board grid renders at the top of the page and is then pushed down
 * by ~80px the moment the loader resolves — at exactly the moment you have
 * started reading the first board.
 *
 * Which tabs get one is declared on the tab (`CategorySpec.tabs[].head`), not
 * guessed here: the placeholder has to know before the data exists, and the
 * System layers genuinely have no service to head.
 */
export function ServiceHeadSkeleton() {
  return (
    // The outer box and the artwork slot are imported from the real header, so
    // the reserved space IS the real space. Only the inner column needs its own
    // rhythm — the real thing gets that from an h2 and two paragraphs.
    <div className={SVC_HEAD}>
      <span className={cn(SK, SVC_LOGO)} />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-[0.15rem]">
        <Bar w="22%" h={18} />
        <Bar w="34%" h={11} />
        <Bar w="72%" h={12} />
      </div>
    </div>
  )
}

// Cards borrow the real component's box so nothing reflows when the content
// lands — only the innards are grey.
const SK_CARD = 'flex flex-col justify-center gap-[0.55rem]'

export function StatBandSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className={STAT_BAND}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn(BIG_STAT, SK_CARD)}>
          <Bar w="45%" h={9} />
          <Bar w="70%" h={26} />
          <Bar w="60%" h={9} />
        </div>
      ))}
    </div>
  )
}

/**
 * The board grid.
 *
 * Spans are passed in rather than assumed so the placeholder matches the real
 * layout of the page being loaded — all five category pages open with a wide
 * board next to a narrow one, and a uniform grid of six would visibly reflow.
 */
export function BoardsSkeleton({ spans = [8, 4, 6, 6] }: { spans?: number[] }) {
  return (
    <div className={BOARD_GRID}>
      {spans.map((span, i) => (
        <section key={i} className={BOARD} style={{ ['--span' as string]: String(span) }}>
          <header className={BOARD_HEAD}>
            <Bar w="35%" h={11} />
          </header>
          <div className={cn(BOARD_BODY, 'gap-2')}>
            <Bar w="100%" h={64} />
            <Bar w="90%" h={12} />
            <Bar w="75%" h={12} />
            <Bar w="82%" h={12} />
          </div>
        </section>
      ))}
    </div>
  )
}

/** The strip of live readings at the top of an app detail tab. */
export function StripSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={STAT_STRIP}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={STAT}>
          <Bar w="55%" h={9} />
          <Bar w="70%" h={20} />
          <Bar w="85%" h={10} />
        </div>
      ))}
    </div>
  )
}

/** The app list on /apps, and anything else that is a stack of equal rows. */
export function RowsSkeleton({ count = 3, height = 58 }: { count?: number; height?: number }) {
  return (
    <ul className={APP_LIST}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div
            className="flex items-center gap-4 rounded-lg border border-(color:--border-soft) bg-card px-4"
            style={{ height }}
          >
            <Bar w="0.6rem" h={10} />
            <Bar w="30%" h={14} />
            <Bar w="22%" h={11} />
            <Bar w="12%" h={11} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The first step of /apps/new: section head, search row, repository list.
 *
 * A generic `RowsSkeleton` was standing in for this, and it reserved neither
 * the head nor the search field — so the placeholder started where the lede
 * ended and the real thing started ~5rem lower. It borrows the picker's own
 * boxes (`PICKER_HEAD`, `PICKER_BOX`, `REPO_ROW`) rather than approximating
 * them, which is what keeps the reserved space and the real space the same
 * space; the rows are the picker's grid, so the bars land in the picker's
 * columns.
 */
export function NewAppSkeleton() {
  return (
    <div className={WIZARD}>
      <section className={WIZARD_STEP}>
        <h2 className={FIRST_STEP_HEAD}>
          <Bar w="8rem" h={9} />
        </h2>
        <div className={PICKER_HEAD}>
          {/* The search field's box, greyed. `h-9` is the Input primitive's
              own height, because that field is what sets the height of the
              head row it sits in. */}
          <span className={cn(SK, PICKER_SEARCH, 'h-9 rounded-md')} />
          <span className={PICKER_COUNT}>
            <Bar w="7rem" h={9} />
          </span>
        </div>
        <div className={PICKER_BOX}>
          <div className={REPO_LIST}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={REPO_OPT}>
                <div className={REPO_ROW}>
                  <Bar w="62%" h={12} />
                  <Bar w="3.4rem" h={12} />
                  <Bar w="74%" h={11} />
                  <Bar w="8rem" h={10} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className={PICKER_HINT}>
          <Bar w="11rem" h={8} />
        </p>
      </section>
    </div>
  )
}

/** A single free-form block, for tabs whose shape is one long list. */
export function BlockSkeleton({ h = 240 }: { h?: number }) {
  return (
    <div
      className={cn(
        'rounded-lg border border-(color:--border-soft)',
        'bg-[image:linear-gradient(90deg,var(--panel)_0%,var(--panel-2)_50%,var(--panel)_100%)] bg-[length:220%_100%]',
        SWEEP,
      )}
      style={{ height: h }}
    />
  )
}
