import { useState } from 'react'
import type {
  UpdateRow,
  UpdatesData,
  UpdateVerdict,
} from '../../../lib/dashboard/categories/system/updates'
import { DASH } from '../../../lib/format'
import { fetchUpdateNotes } from '../../../server/updates'
import { UpdateControl } from '../../image-update'
import { Changelog } from '../../release-notes'
import { Board, BoardGrid, Chip, type Tone } from '../../viz'

// Every pinned image on the box, and what it would take to move it.
//
// The one page here whose subject is the fleet rather than a service — and the
// only place a third of these containers appear at all. The exporters, the
// redis and postgres sidecars, the *arr janitors, the six plane processes
// behind one web app: none has a tab, none will get one, and every one of them
// carries a pin that ages exactly like Jellyfin's.
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
// Notes load per row, on open. Sixty-five GitHub release lists on page load
// would spend an hourly budget answering a question about sixty-four
// containers nobody asked about — see the loader for the rest of that.

const VERDICT: Record<UpdateVerdict, { label: string; tone: Tone }> = {
  'tag-moved': { label: 'tag moved', tone: 'warn' },
  'newer-tag': { label: 'newer tag', tone: 'warn' },
  current: { label: 'current', tone: 'ok' },
  unknown: { label: 'no verdict', tone: 'muted' },
}

export function UpdatesView({ d }: { d: UpdatesData }) {
  const behind = d.rows.filter((r) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag')
  const rest = d.rows.filter((r) => r.verdict === 'current' || r.verdict === 'unknown')

  return (
    <BoardGrid>
      <Board
        title={d.behind === 0 ? 'Everything is on its newest tag' : `${String(d.behind)} behind`}
        icon="logs"
        span={12}
        aside={
          <span className="board-note">
            {d.probeMissing
              ? 'the registry probe has not run'
              : `registry checked ${(d.checkedAt ?? '').slice(0, 10)}`}
          </span>
        }
      >
        {behind.length === 0 ? (
          <p className="viz-empty">
            Every digest-pinned container is on the newest tag of its shape, and no channel tag has
            moved since it was pinned.
          </p>
        ) : (
          <ul className="upd-rows">
            {behind.map((r) => (
              <Row key={r.container} r={r} status={d.status} />
            ))}
          </ul>
        )}
        <p className="board-foot">
          Pins come from the flake; the verdicts from a daily registry probe. A tag that MOVED is a
          channel pin like <span className="mono">:latest</span> whose image was replaced, so the
          update is the same tag and a new digest. A NEWER TAG is a frozen release pin with a higher
          version published beside it, and the notes inside the row are what that version contains.
        </p>
      </Board>

      <Board
        title="On the newest tag"
        icon="logs"
        span={12}
        aside={<span className="board-note">{String(rest.length)} containers</span>}
      >
        <ul className="upd-rows is-quiet">
          {rest.map((r) => (
            <Row key={r.container} r={r} status={d.status} />
          ))}
        </ul>
        <p className="board-foot">
          Open one to read what its current version shipped. “No verdict” means the registry did not
          answer for it, or the pin names a channel with nothing to compare against. Treat it as
          unknown.
        </p>
      </Board>
    </BoardGrid>
  )
}

function Row({ r, status }: { r: UpdateRow; status: UpdatesData['status'] }) {
  const v = VERDICT[r.verdict]
  const [notes, setNotes] = useState<Notes | null>(null)

  return (
    <li className="upd-row">
      <details
        onToggle={(e) => {
          // On open, once. `<details>` renders its children whether or not it
          // is open, so a fetch on mount would be every row on the page asking
          // GitHub at once — which is the all-at-once load the loader exists
          // to avoid. `notes` doubles as the has-run flag.
          if (!e.currentTarget.open || notes !== null || !r.hasNotes) return
          setNotes({ loading: true, data: null })
          void fetchUpdateNotes({ data: { container: r.container } }).then((data) => {
            setNotes({ loading: false, data })
          })
        }}
      >
        <summary>
          <span className="upd-name">{r.container}</span>
          <span className="upd-from mono">{r.running.version ?? r.tag}</span>
          {/* For a moved CHANNEL pin both tags are the same string, so the
              only honest thing the digests can say is "new digest" — unless
              the image states its own version, in which case that IS the
              answer and the one worth reading. */}
          <span className="upd-to mono">
            {r.verdict === 'tag-moved'
              ? (r.freshness?.remoteVersion ?? 'new digest')
              : (r.freshness?.newerTag ?? DASH)}
          </span>
          <Chip tone={v.tone}>{v.label}</Chip>
          {!r.updatable && <Chip tone="muted">pinned</Chip>}
        </summary>

        <div className="upd-body">
          <NotesPanel notes={notes} hasNotes={r.hasNotes} />
          <UpdateControl
            target={{
              container: r.container,
              tag: r.tag,
              target: r.target,
              candidates: r.candidates,
              updatable: r.updatable,
              lockstep: r.lockstep,
              ceremony: r.ceremony,
            }}
            initialStatus={status}
          />
          <p className="upd-ref mono">{`${r.image}@${r.digest.slice(0, 19)}…`}</p>
        </div>
      </details>
    </li>
  )
}

/** What one row has fetched, or is fetching. */
type Notes = { loading: boolean; data: Awaited<ReturnType<typeof fetchUpdateNotes>> | null }

function NotesPanel({ notes, hasNotes }: { notes: Notes | null; hasNotes: boolean }) {
  if (!hasNotes) {
    return (
      <p className="viz-empty">
        No release notes: nothing maps this container to a project whose changelog we can read. The
        tag delta above is still the real answer to what a re-pull would bring. See
        <code> lib/dashboard/image-repos.ts</code> for why a guess is not offered instead.
      </p>
    )
  }

  if (notes === null || notes.data === null) {
    return <p className="viz-empty">Reading the release notes…</p>
  }

  return <Changelog gap={notes.data.gap} build={notes.data.build} span={12} />
}
