import { useState } from 'react'
import { EngineCard } from '../../../components/engine-update'
import { ImageRow, ImageTableHead } from '../../../components/image-row'
import { NixosCard } from '../../../components/nixos-card'
import { TABLE, TABLE_EMPTY, TableGroup } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import { ceremonyFor } from '../../../lib/image-ceremony'
import type { UpdateRow, UpdatesData } from '../data/updates'
import { type QueueItem, QueuePanel } from './queue-panel'

// Every pinned image on the box, and what it would take to move it.
//
// The one page here whose subject is the fleet rather than a service — see
// ../data/updates.ts for why the tab-less containers need it.
//
// ── the row is the unit, and it opens ─────────────────────────────────────
//
// Closed, a row is the decision in one line: what is running, what is
// available, and how confident the verdict is. Open, it is the reason —
// release notes between the two versions, the tag picker, and the button.
//
// That order is the whole argument of the page. Reading what changed is not a
// step before updating, it IS the update decision, and a button reachable
// without passing the notes is a button that gets pressed without them. So the
// control lives INSIDE the disclosure, never in the closed row.
//
// Notes load per row, on open — the loader says why.
//
// Last, the images built on the box: their bases, the build tools, a source
// commit. Same rows, same verdicts where a registry can give one, each naming
// the file a bump edits — and, for a base this configuration pins, the same
// button and the same queue as a container's.
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
// clicking, and persisting it would mean a schema, a stale-entry problem, and
// two operators' queues to reconcile on a box that has one operator.
//
// What it does NOT do is soften the decision. Each entry was armed in its own
// row, behind that row's changelog and its ceremony prompt if it has one, and
// the panel restates every warning before the button. The all-or-nothing
// consequence is stated there too, because it is the one thing batching
// changes about the outcome: a single bad image reverts the whole commit.

export function UpdatesView({ d }: { d: UpdatesData }) {
  const behind = d.rows.filter((r) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag')
  const rest = d.rows.filter((r) => r.verdict === 'current' || r.verdict === 'unknown')

  const [queue, setQueue] = useState<QueueItem[]>([])

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

  const moved = behind.filter((r) => r.verdict === 'tag-moved')
  const newer = behind.filter((r) => r.verdict === 'newer-tag')
  const unknown = rest.filter((r) => r.verdict === 'unknown')
  const current = rest.filter((r) => r.verdict === 'current')
  const group = (rows: UpdateRow[]) =>
    rows.map((r) => (
      <ImageRow key={r.container} r={r} status={d.status} queue={bind(r)} table="grouped" />
    ))

  return (
    <div className="flex flex-col gap-10">
      <BoardGrid>
        {/* The engine first: the one pin here that is not a container, and the
            one whose update restarts the page reporting it. Then the release the
            whole generation stands on. */}
        <EngineCard e={d.engine} />
        <NixosCard facts={d.nixos} />
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
      </BoardGrid>

      {/* Every container in ONE table, grouped by verdict: the group names the
          verdict once, so a row carries a chip only where it differs from its
          group (pinned by policy, queued). Behind first — that is the question
          the list answers — and the settled ones last, quiet: no target, no
          chip, nothing to read unless you open one. */}
      <TableSection
        title={
          d.behind === 0
            ? 'Every container is on its newest tag'
            : `${String(d.behind)} containers behind`
        }
        aside={
          d.probeMissing
            ? 'the registry probe has not run'
            : `registry checked ${(d.checkedAt ?? '').slice(0, 10)}`
        }
      >
        <ul className={TABLE}>
          <ImageTableHead />
          {behind.length === 0 && (
            <li className={TABLE_EMPTY}>
              Every digest-pinned container is on the newest tag of its shape, and no channel tag
              has moved since it was pinned.
            </li>
          )}
          {moved.length > 0 && (
            <TableGroup
              title={`Tag moved · ${String(moved.length)}`}
              note="same tag, a new image behind it"
            />
          )}
          {group(moved)}
          {newer.length > 0 && (
            <TableGroup
              title={`Newer tag · ${String(newer.length)}`}
              note="a higher release of the same shape is published"
            />
          )}
          {group(newer)}
          {unknown.length > 0 && (
            <TableGroup
              title={`No verdict · ${String(unknown.length)}`}
              note="the registry did not answer, or there is nothing to compare against"
            />
          )}
          {group(unknown)}
          {current.length > 0 && (
            <TableGroup
              title={`On the newest tag · ${String(current.length)}`}
              note="nothing to do"
            />
          )}
          {group(current)}
        </ul>
        <p className={FOOT}>
          Pins come from the flake; the verdicts from a daily registry probe. A tag that MOVED is a
          channel pin like <span className={MONO}>:latest</span> whose image was replaced, so the
          update is the same tag and a new digest. A NEWER TAG is a frozen release pin with a higher
          version published beside it, and the notes inside the row are what that version contains.
        </p>
        <p className={FOOT}>
          Open one to read what its current version shipped. “No verdict” means the registry did not
          answer for it, or the pin names a channel with nothing to compare against. Treat it as
          unknown.
        </p>
      </TableSection>

      <TableSection title="Built on the box" aside={`${String(d.manual.length)} pins`}>
        <ul className={TABLE}>
          <ImageTableHead />
          {d.manual.length === 0 ? (
            <li className={TABLE_EMPTY}>
              Nothing on this box is pinned outside a container image.
            </li>
          ) : (
            d.manual.map((r) => (
              <ImageRow
                key={r.container}
                r={r}
                status={d.status}
                queue={r.updatable ? bind(r) : undefined}
                table="row"
              />
            ))
          )}
        </ul>
        <p className={FOOT}>
          The bases of the images built on this box, the build tools, a source commit. A base this
          configuration pins has the Update button: it rewrites the pin, rebuilds the image on the
          new base and checks the container came back carrying it. The rest are commits by hand — an
          engine pin is an engine commit, then Engine › Update. A commit pin has no registry to ask,
          so it reads “no verdict” — open it for the commits since.
        </p>
      </TableSection>
    </div>
  )
}
