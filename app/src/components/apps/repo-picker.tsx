// Choosing the repository — the one input the rest of /apps/new is derived
// from.
//
// A combobox rather than a column of buttons. An account can carry a hundred
// repositories, and with a tab stop per row reaching the form below the list
// would cost a hundred presses; here the input owns focus for good and
// `aria-activedescendant` moves the reader's cursor without moving the DOM's.
// That is also why the rows carry `tabIndex={-1}` — they are pointer targets
// and screen-reader options, never keyboard stops.
//
// Repos that are already apps stay in the list and stay legible, as links to
// the app they became — which is where somebody who typed that name wants to
// end up.

import { Link, useRouter } from '@tanstack/react-router'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Repo } from '../../host/github-repos'
import { cn } from '../../lib/cn'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { GLASS } from '../viz/board'
import { Cells, Chips, Derivation, REPO_DESC, REPO_NAME } from './repo-row'
import { GHOST_BTN } from './shared'

/* The picker's boxes, exported for `NewAppSkeleton`: the placeholder borrows
   them rather than approximating them, which is what keeps the reserved space
   and the real space the same space. */

/** The picker's top edge: the field on the left, the tally on the right, both
    aligned with the list below them. */
export const PICKER_HEAD = 'mb-3 flex items-center gap-4'
/** The search field's share of that row. */
export const PICKER_SEARCH = 'flex-[0_1_22rem]'
export const PICKER_COUNT =
  'ml-auto text-[0.75rem] whitespace-nowrap text-muted-foreground tabular-nums'

/** The frame. The border and the radius sit here rather than on the scroller:
    a mask applied to the bordered element fades the border away with the rows. */
export const PICKER_BOX = cn(GLASS, 'overflow-hidden [--repo-row-h:2.9rem]')

/* One grid for the whole list rather than one per row. A row-level grid sizes
   its chip column to that row's OWN chips, which is why the description used
   to start at a different x on every line; subgrid hands every row the list's
   tracks, so `auto` can mean "the widest chip set in the list".

   The mask is a soft bottom edge instead of a row sliced in half at the scroll
   boundary. It is fixed to the scroller's viewport, not to its content, which
   is what the padding-bottom is for: the last 1.6rem of scrollable content is
   empty, so the fade never dims a row the reader has scrolled all the way to.
   The trade is that the fade is unconditional — it does not know whether the
   list overflows — which is a scroll listener's worth of JavaScript behind a
   decoration, and the padding is the cheaper half of that bargain. */
export const REPO_LIST = cn(
  'grid grid-cols-[minmax(6rem,14rem)_auto_minmax(0,1fr)_auto] gap-x-4 overflow-x-hidden overflow-y-auto pb-6',
  'max-h-[calc(var(--repo-row-h)_*_8_+_1.6rem)] mask-b-from-[calc(100%_-_1.6rem)]',
  '[&>*+*]:border-hairline [&>*+*]:border-t',
)

/* Without subgrid the row keeps fixed tracks: the chip column stops sizing
   itself to the list, but every description still starts at one x. */
const NO_SUBGRID =
  'not-supports-[grid-template-columns:subgrid]:grid-cols-[minmax(6rem,14rem)_10rem_minmax(0,1fr)_auto]'

export const REPO_OPT = cn('group/opt col-span-full grid min-w-0 grid-cols-subgrid', NO_SUBGRID)

/* A button for a repo that can be picked, a link for one that is already an
   app — the same row either way, because the difference is where it takes you,
   not how much it matters. Never a tab stop (see the file header). */
export const REPO_ROW = cn(
  'group/row col-span-full grid min-h-(--repo-row-h) w-full cursor-pointer grid-cols-subgrid items-baseline border-0 bg-transparent px-4 py-2.5 text-left text-foreground',
  NO_SUBGRID,
  'hover:bg-foreground/[0.05] hover:no-underline group-aria-selected/opt:bg-foreground/[0.075] group-aria-selected/opt:no-underline',
  // Inset, unlike the shell's rings: the row is full-bleed inside a clipping
  // frame, so an outward offset would be cut off by the picker box.
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-dim',
)

export const PICKER_HINT = 'mt-2 mb-0 text-[0.72rem] text-muted-foreground'

/* Picked, so the search and the list collapse to the single line they
   produced — the choice is made, and the page below it is the point now. */
const REPO_PICKED = cn(GLASS, 'flex flex-wrap items-baseline gap-x-3.5 gap-y-2 px-4 py-3')

export function RepoPicker({
  repos,
  taken,
  picked,
  search,
  hostname,
  image,
  postgres,
  onSearch,
  onPick,
  onClear,
}: {
  repos: readonly Repo[]
  taken: readonly string[]
  picked: Repo | null
  search: string
  /** The step-2 overrides, so the derivation under the pick tracks them live. */
  hostname: string
  image: string
  postgres: boolean
  onSearch: (v: string) => void
  onPick: (r: Repo) => void
  onClear: () => void
}) {
  const router = useRouter()
  const base = useId()
  const listId = `${base}-list`
  const optionId = (i: number) => `${base}-opt-${String(i)}`

  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  // Set by `change`, read after the parent has cleared the pick: the input the
  // focus belongs on does not exist until this component re-renders as a list.
  const wantsFocus = useRef(false)

  const visible = repos.filter(
    (r) =>
      search === '' ||
      `${r.name} ${r.description ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  )
  // Clamped rather than corrected in an effect: a filter that shortens the list
  // must not leave a highlight pointing past its end for one paint.
  const activeIndex = Math.min(active, Math.max(visible.length - 1, 0))
  const activeRepo = visible[activeIndex]
  const activeTaken = activeRepo !== undefined && taken.includes(activeRepo.name)

  useEffect(() => {
    if (picked === null && wantsFocus.current) {
      wantsFocus.current = false
      inputRef.current?.focus()
    }
  }, [picked])

  // Addressed by index rather than by an `is-active` marker: the row to scroll
  // to is what this effect depends on, and reading it from the DOM instead
  // would leave `activeIndex` an unused dependency that lint is right to want
  // removed — and removing it would run this once, on mount, forever.
  // `nearest` so arrowing down scrolls by one row rather than recentring the
  // whole list under the reader on every press.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(activeIndex)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const activate = (r: Repo | undefined) => {
    if (r === undefined) return
    if (taken.includes(r.name)) {
      void router.navigate({
        to: '/apps/$name',
        params: { name: r.name },
        search: { tab: 'overview' as const },
      })
      return
    }
    onPick(r)
  }

  const move = (to: number) => {
    if (visible.length === 0) return
    setActive(((to % visible.length) + visible.length) % visible.length)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(activeIndex + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(activeIndex - 1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      move(visible.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(activeRepo)
    } else if (e.key === 'Escape' && search !== '') {
      e.preventDefault()
      onSearch('')
    } else if (e.key === 'Escape') {
      inputRef.current?.blur()
    }
  }

  if (picked !== null) {
    return (
      <>
        {/* A flex row, not the list's grid: the name and its chips are the
            answer and never shrink; the description takes what is left. */}
        <div className={REPO_PICKED}>
          <span className={cn(REPO_NAME, 'flex-none text-[1rem]')}>{picked.name}</span>
          <Chips repo={picked} taken={taken.includes(picked.name)} className="flex-none" />
          <span className={cn(REPO_DESC, 'flex-[1_1_14rem]')}>{picked.description ?? '—'}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(GHOST_BTN, 'ml-auto')}
            onClick={() => {
              wantsFocus.current = true
              onClear()
            }}
          >
            change
          </Button>
        </div>
        <Derivation name={picked.name} hostname={hostname} image={image} postgres={postgres} />
      </>
    )
  }

  const count =
    search === ''
      ? `${String(repos.length)} ${repos.length === 1 ? 'repository' : 'repositories'}`
      : `${String(visible.length)} of ${String(repos.length)}`

  return (
    <>
      <div className={PICKER_HEAD}>
        <Input
          ref={inputRef}
          className={PICKER_SEARCH}
          type="search"
          placeholder="Search repositories…"
          value={search}
          role="combobox"
          aria-expanded={visible.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRepo === undefined ? undefined : optionId(activeIndex)}
          onKeyDown={onKeyDown}
          onChange={(e) => {
            onSearch(e.target.value)
            setActive(0)
          }}
        />
        <span className={PICKER_COUNT}>{count}</span>
      </div>

      <div className={PICKER_BOX}>
        {/* Divs rather than ul/li: the listbox and option roles replace list
            semantics outright, so the elements carrying them may as well be
            neutral. */}
        <div
          id={listId}
          ref={listRef}
          className={REPO_LIST}
          role="listbox"
          aria-label="Repositories"
        >
          {visible.map((r, i) => {
            const already = taken.includes(r.name)
            const isActive = i === activeIndex
            return (
              <div
                key={r.name}
                id={optionId(i)}
                className={REPO_OPT}
                role="option"
                aria-selected={isActive}
                data-index={String(i)}
                tabIndex={-1}
              >
                {already ? (
                  <Link
                    to="/apps/$name"
                    params={{ name: r.name }}
                    search={{ tab: 'overview' as const }}
                    className={REPO_ROW}
                    tabIndex={-1}
                    onMouseMove={() => {
                      setActive(i)
                    }}
                  >
                    <Cells repo={r} taken />
                  </Link>
                ) : (
                  <button
                    type="button"
                    className={REPO_ROW}
                    tabIndex={-1}
                    onMouseMove={() => {
                      setActive(i)
                    }}
                    onClick={() => {
                      onPick(r)
                    }}
                  >
                    <Cells repo={r} taken={false} />
                  </button>
                )}
              </div>
            )
          })}
          {visible.length === 0 && (
            <div className="col-span-full px-4 py-6 text-[0.85rem] text-muted-foreground">
              No repositories match that filter.
            </div>
          )}
        </div>
      </div>

      <p className={PICKER_HINT}>↑↓ navigate · ↵ {activeTaken ? 'open app' : 'select'}</p>
    </>
  )
}
