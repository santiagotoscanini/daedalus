import { Fragment, useMemo, useState } from 'react'
import { AppIcon, Segmented } from '../../../components/controls'
import { EngineCard } from '../../../components/engine-update'
import { Chevron, ImageRow, ImageTableHead } from '../../../components/image-row'
import { NixosCard } from '../../../components/nixos-card'
import { CELL_NAME, CELL_QUIET, TABLE, TABLE_EMPTY, TABLE_ROW } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO } from '../../../components/tokens'
import { Input } from '../../../components/ui/input'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { rowKey, type ServiceGroup } from '../../../lib/dashboard/service-groups'
import { ceremonyFor } from '../../../lib/image-ceremony'
import type { UpdateRow, UpdatesData } from '../data/updates'
import { type QueueItem, QueuePanel } from './queue-panel'

// Every pinned image on the box, and what it would take to move it.
//
// The one page here whose subject is the fleet rather than a service — see
// ../data/updates.ts for why the tab-less containers need it.
//
// ── the service is the unit ───────────────────────────────────────────────
//
// A person updates Immich, not four containers: its server, machine learning,
// postgres and redis are one decision read from one changelog. So the page is
// a list of SERVICES (lib/dashboard/service-groups.ts), each with its icon and
// one verdict for the whole set, opening to the pins inside it — containers
// and, beside them, the bases the box builds that service's images on. A
// service of one container is that container's row, icon and all: a header
// over a single row would say its name twice.
//
// Services with something behind come first and start open; the settled ones
// are a quiet list underneath, shut. The filter narrows to what needs doing,
// and the search finds one service by any name it goes by — its own, a
// container's, the image's — which is how a person arrives here wanting to
// update one specific thing.
//
// ── the row is the decision, and it opens ─────────────────────────────────
//
// Closed, a row is the decision in one line: what is running, what is
// available, and how confident the verdict is. Open, it is the reason —
// release notes between the two versions, the tag picker, and the button.
// Reading what changed is not a step before updating, it IS the update
// decision, and a button reachable without passing the notes is a button that
// gets pressed without them. So the control lives INSIDE the disclosure,
// never in the closed row. Notes load per row, on open.
//
// ── the queue ─────────────────────────────────────────────────────────────
//
// Reading every row and deciding six of them should move is one sitting;
// six rebuilds, six rounds of container restarts and six waits is not. So a row
// can be added to a queue instead of updated, and the queue goes to the host as
// ONE request: one commit, one build, one switch.
//
// The queue lives in this component's state and nowhere else. It is a
// selection, not a commitment — nothing has been asked of the host until the
// button is pressed, so there is nothing for a reload to lose except the
// clicking. Each entry was armed in its own row, behind that row's changelog
// and its ceremony prompt if it has one, and the panel restates every warning
// before the button, with the one thing batching changes: a single bad image
// reverts the whole commit.

type Filter = 'behind' | 'all'

const isBehind = (r: UpdateRow) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag'

/** A group's worst verdict first: what needs doing, then what cannot be told, then the settled. */
function rank(rows: UpdateRow[]): number {
  if (rows.some(isBehind)) return 0
  if (rows.some((r) => r.verdict === 'unknown')) return 1
  return 2
}

/** What a pin is, when it is not a container's own image. */
function badgeOf(r: UpdateRow): string | undefined {
  if (r.kind === 'container') return undefined
  if (r.pinnedIn.repo === 'engine') return 'engine'
  return r.image === null ? 'source' : 'base'
}

/** Every name a row answers to, lower-cased, for the search. */
function haystack(g: ServiceGroup, rows: UpdateRow[]): string {
  return [g.id, g.label, ...rows.flatMap((r) => [r.container, r.image ?? ''])]
    .join(' ')
    .toLowerCase()
}

/**
 * A service's logo on a white tile. Logos are drawn for a light page — some
 * are white (Nextcloud), some black (Pocket ID, Open WebUI) — so a tile of their
 * own is what keeps every one legible in both themes, the way an integrations
 * list shows them.
 */
function ServiceIcon({ g, size = 24 }: { g: ServiceGroup; size?: number }) {
  if (g.icon === null) return <AppIcon name={g.label} hasIcon={false} size={size} />
  return (
    <span
      className="grid flex-none place-items-center rounded-md bg-white shadow-[inset_0_0_0_1px_color-mix(in_oklch,black_10%,transparent)]"
      style={{ width: size, height: size }}
    >
      <img
        className="block object-contain"
        src={g.icon}
        alt=""
        width={size - 6}
        height={size - 6}
        loading="lazy"
        decoding="async"
      />
    </span>
  )
}

/** The group's one-line verdict, on its header. */
function GroupVerdict({ rows }: { rows: UpdateRow[] }) {
  const behind = rows.filter(isBehind).length
  if (behind > 0) return <Chip tone="warn">{`${String(behind)} behind`}</Chip>
  if (rows.every((r) => r.verdict === 'unknown')) return <Chip tone="muted">no verdict</Chip>
  if (rows.some((r) => r.verdict === 'unknown'))
    return <span className={CELL_QUIET}>current · some unknown</span>
  return <span className={CELL_QUIET}>current</span>
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`
}

export function UpdatesView({ d }: { d: UpdatesData }) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  // Which groups the person has opened or shut by hand. Absent = the default:
  // open when something in it is behind.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  const byKey = useMemo(() => {
    const m = new Map<string, UpdateRow>()
    for (const r of [...d.rows, ...d.manual]) m.set(rowKey(r), r)
    return m
  }, [d.rows, d.manual])

  // Groups with their rows, worst first, then by name — fixed for the page's
  // life, so a row does not jump while the person is reading it.
  const groups = useMemo(
    () =>
      d.groups
        .map((g) => {
          const rows = g.members.map((k) => byKey.get(k)).filter((r) => r !== undefined)
          return { g, rows, text: haystack(g, rows) }
        })
        .filter((x) => x.rows.length > 0)
        .sort((a, b) => rank(a.rows) - rank(b.rows) || a.g.label.localeCompare(b.g.label)),
    [d.groups, byKey],
  )

  // Which containers the queue already accounts for, and on whose behalf.
  // A lockstep member is covered by its primary, so queueing immich covers
  // immich-machine-learning — and the host would refuse the pair anyway.
  const covered = new Map<string, string>()
  for (const q of queue) {
    covered.set(q.container, q.container)
    for (const m of q.lockstep) covered.set(m, q.container)
  }

  const bind = (r: UpdateRow) => {
    const owner = covered.get(r.container)
    return {
      queued: owner === r.container,
      blockedBy: owner === undefined || owner === r.container ? null : owner,
      add: (toTag: string | null, typed: string) => {
        setQueue((q) => [
          ...q.filter((i) => i.container !== r.container),
          {
            container: r.container,
            toTag,
            tag: r.tag ?? '',
            lockstep: r.lockstep,
            // What THIS move owes: a new major can, where its re-pull does not.
            ceremony: ceremonyFor({ ...r, tag: r.tag ?? '' }, toTag),
            typed,
          },
        ])
      },
      remove: () => {
        setQueue((q) => q.filter((i) => i.container !== r.container))
      },
    }
  }

  const needle = query.trim().toLowerCase()
  const behindRows = [...d.rows, ...d.manual].filter(isBehind).length
  const allRows = d.rows.length + d.manual.length
  const visible = groups
    .map(({ g, rows, text }) => {
      // A search that names the service keeps all of it; one that names a
      // container keeps that container.
      const hitGroup =
        needle === '' || g.label.toLowerCase().includes(needle) || g.id.includes(needle)
      let shown = rows
      if (!hitGroup) {
        shown = text.includes(needle)
          ? rows.filter((r) => `${r.container} ${r.image ?? ''}`.toLowerCase().includes(needle))
          : []
      }
      if (filter === 'behind') shown = shown.filter(isBehind)
      return { g, rows: shown, all: rows }
    })
    .filter((x) => x.rows.length > 0)

  const row = (
    r: UpdateRow,
    extra: { lead?: React.ReactNode; name?: string; nested?: boolean },
  ) => (
    <ImageRow
      key={rowKey(r)}
      r={r}
      status={d.status}
      queue={r.kind === 'container' || r.updatable ? bind(r) : undefined}
      table="row"
      badge={badgeOf(r)}
      {...extra}
    />
  )

  return (
    <div className="flex flex-col gap-10">
      <QueuePanel
        queue={queue}
        initialStatus={d.status}
        onRemove={(c) => {
          setQueue((q) => q.filter((i) => i.container !== c))
        }}
        onClear={() => {
          setQueue([])
        }}
      />

      <TableSection
        title={
          behindRows === 0
            ? 'Every service is on its newest tag'
            : `${plural(behindRows, 'pin')} behind`
        }
        aside={
          d.probeMissing
            ? 'the registry probe has not run'
            : `registry checked ${(d.checkedAt ?? '').slice(0, 10)}`
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <div className="min-w-[14rem] flex-1">
            <Input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('')
                  e.currentTarget.blur()
                }
              }}
              placeholder="Find a service, container or image"
              aria-label="Find a service, container or image"
            />
          </div>
          <Segmented<Filter>
            label="Which pins to show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'behind', label: 'Needs update', count: behindRows },
              { value: 'all', label: 'All', count: allRows },
            ]}
          />
        </div>

        <ul className={TABLE}>
          <ImageTableHead first="Service" iconned />
          {visible.length === 0 && (
            <li className={TABLE_EMPTY}>
              {needle !== ''
                ? `Nothing here answers to “${query.trim()}”.`
                : 'Every pinned image is on the newest tag of its shape, and no channel tag has moved since it was pinned.'}
            </li>
          )}
          {visible.map(({ g, rows, all }) => {
            // A service that is one row is drawn as that row, its icon inline.
            const solo = all.length === 1 ? rows[0] : undefined
            if (solo !== undefined) return row(solo, { lead: <ServiceIcon g={g} />, name: g.label })
            const open = needle !== '' || (toggled[g.id] ?? rank(all) === 0)
            const containers = all.filter((r) => r.kind === 'container').length
            const pins = all.length - containers
            return (
              <Fragment key={g.id}>
                <li className={cn(TABLE_ROW, 'min-h-0 p-0')}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => {
                      setToggled((t) => ({ ...t, [g.id]: !open }))
                    }}
                    className={cn(
                      'group flex min-h-[3.25rem] w-full cursor-pointer items-center px-5 py-2 text-left text-[0.8125rem] transition-colors duration-100',
                      'hover:bg-foreground/[0.025] focus-visible:shadow-[inset_0_0_0_2px_var(--brand-dim)] focus-visible:outline-none',
                    )}
                  >
                    <Chevron open={open} />
                    <span className="mr-2.5 flex flex-none">
                      <ServiceIcon g={g} />
                    </span>
                    <span className={cn(CELL_NAME, 'min-w-0')}>{g.label}</span>
                    <span className={cn(CELL_QUIET, 'ml-2 truncate')}>
                      {[
                        containers > 0 && plural(containers, 'container'),
                        pins > 0 && plural(pins, 'build pin'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="ml-auto flex flex-none items-center pl-3">
                      <GroupVerdict rows={all} />
                    </span>
                  </button>
                </li>
                {open && rows.map((r) => row(r, { nested: true }))}
              </Fragment>
            )
          })}
        </ul>
        <p className={FOOT}>
          One line per service, opening to its pins: the containers, and the bases this box builds
          their images on. Pins come from the flake; the verdicts from a daily registry probe. A tag
          that MOVED is a channel pin like <span className={MONO}>:latest</span> whose image was
          replaced, so the update is the same tag and a new digest. A NEWER TAG is a frozen release
          pin with a higher version published beside it, and the notes inside the row are what that
          version contains. “No verdict” means the registry did not answer for it, or the pin names
          a channel with nothing to compare against.
        </p>
        <p className={FOOT}>
          A <span className={MONO}>base</span> this configuration pins has the Update button: it
          rewrites the pin, rebuilds the image on the new base and checks the container came back
          carrying it. An <span className={MONO}>engine</span> pin is an engine commit, then Engine
          › Update; a <span className={MONO}>source</span> pin is a commit, read as the commits
          since.
        </p>
      </TableSection>
      {/* Then the engine — the one pin that is not an image, and the one whose
          update restarts the page reporting it — and the release the whole
          generation stands on. Below the services: they are what this page is
          opened for. */}
      <EngineCard e={d.engine} />
      <NixosCard facts={d.nixos} />
    </div>
  )
}
