// Choosing the repository — the one input the rest of /apps/new is derived
// from.
//
// A combobox rather than a column of buttons. The account carries ~100
// repositories and every row used to be a tab stop, so reaching the form below
// the list cost a hundred presses; here the input owns focus for good and
// `aria-activedescendant` moves the reader's cursor without moving the DOM's.
// That is also why the rows carry `tabIndex={-1}` — they are pointer targets
// and screen-reader options, never keyboard stops.
//
// Repos that are already apps stay in the list and stay legible. They used to
// be `disabled` at 45% opacity, with the reason hidden in a title attribute;
// they are now links to the app they became, which is where somebody who typed
// that name wants to end up.

import { Link, useRouter } from '@tanstack/react-router'
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { Repo } from '../../lib/github-repos'
import { BASE_DOMAIN } from '../../lib/hostname'
import { defaultImage } from '../../lib/site'

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
        <div className="repo-picked">
          <span className="repo-name">{picked.name}</span>
          <Chips repo={picked} taken={taken.includes(picked.name)} />
          <span className="repo-desc">{picked.description ?? '—'}</span>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              wantsFocus.current = true
              onClear()
            }}
          >
            change
          </button>
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
      <div className="picker-head">
        <input
          ref={inputRef}
          className="search"
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
        <span className="picker-count">{count}</span>
      </div>

      <div className="picker-box">
        {/* Divs rather than ul/li: the listbox and option roles replace list
            semantics outright, so the elements carrying them may as well be
            neutral. */}
        <div
          id={listId}
          ref={listRef}
          className="repo-list"
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
                className="repo-opt"
                role="option"
                aria-selected={isActive}
                data-index={String(i)}
                // Focusable but never a tab stop: the input holds focus for the
                // life of the picker and moves aria-activedescendant instead.
                tabIndex={-1}
              >
                {already ? (
                  <Link
                    to="/apps/$name"
                    params={{ name: r.name }}
                    search={{ tab: 'overview' as const }}
                    className="repo-row repo-row-taken"
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
                    className="repo-row"
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
          {visible.length === 0 && <div className="empty">No repositories match that filter.</div>}
        </div>
      </div>

      <p className="picker-hint">↑↓ navigate · ↵ {activeTaken ? 'open app' : 'select'}</p>
    </>
  )
}

/** The four cells of a row, in the order the list's grid tracks expect them. */
function Cells({ repo, taken }: { repo: Repo; taken: boolean }) {
  return (
    <>
      <span className="repo-name">{repo.name}</span>
      <Chips repo={repo} taken={taken} />
      <span className="repo-desc">{repo.description ?? '—'}</span>
      <span className="repo-meta">
        {repo.language ?? '—'} · {repo.pushedAt ? fmtWhen(repo.pushedAt) : 'never pushed'}
        {taken && (
          <span className="repo-go" aria-hidden="true">
            →
          </span>
        )}
      </span>
    </>
  )
}

function Chips({ repo, taken }: { repo: Repo; taken: boolean }) {
  return (
    <span className="repo-chips">
      {repo.private && <span className="chip chip-muted">private</span>}
      {repo.archived && <span className="chip chip-warn">archived</span>}
      {taken && <span className="chip chip-off">already an app</span>}
    </span>
  )
}

/**
 * What the repository name becomes.
 *
 * The lede promises that everything downstream is derived from this one
 * string; this is that promise rendered, with the name tinted inside each
 * derived value so a single token can be watched propagating into the
 * container, the hostname and the image. Live, because two of the three are
 * overridable in step 2 and the panel is the only place that shows what an
 * override actually did.
 */
function Derivation({
  name,
  hostname,
  image,
  postgres,
}: {
  name: string
  hostname: string
  image: string
  postgres: boolean
}) {
  const rows = [
    { label: 'container', value: `app-${name}` },
    { label: 'hostname', value: hostname.trim() || `${name}.${BASE_DOMAIN}` },
    { label: 'image', value: image.trim() || defaultImage(name) },
  ]
  if (postgres) rows.push({ label: 'postgres', value: name })

  return (
    <dl className="derive">
      {rows.map((r) => (
        <Fragment key={r.label}>
          <dt>{r.label}</dt>
          <dd className="mono">
            <Threaded value={r.value} token={name} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * One occurrence of `token` inside `value`, tinted.
 *
 * Composed from slices rather than from a marked-up string: these values are
 * hostnames and image references, which is exactly the operator-supplied text
 * that must never take a path through innerHTML. An override that no longer
 * contains the name renders plainly — a hostname somebody typed by hand is not
 * a derivation, and colouring a coincidence would be a lie about the mechanism
 * this panel exists to show.
 */
function Threaded({ value, token }: { value: string; token: string }) {
  const at = token === '' ? -1 : value.indexOf(token)
  if (at === -1) return <>{value}</>
  return (
    <>
      {value.slice(0, at)}
      <span className="derive-token">{token}</span>
      {value.slice(at + token.length)}
    </>
  )
}

function fmtWhen(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'pushed today'
  if (days < 30) return `pushed ${String(days)}d ago`
  return `pushed ${iso.slice(0, 7)}`
}
