import { Link } from '@tanstack/react-router'

import type { BoardInfo } from '../../lib/dashboard/board-info'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../lib/format'
import { partMatching } from '../../lib/hardware/catalog'
import { gigabyteRevision } from '../../lib/hardware/gigabyte'
import type { Tone } from '../../lib/tone'
import { PartPhoto } from '../part'
import { Board, BoardGrid, Chip, Facts, Measures } from '../viz'
import {
  ago,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  shortVendor,
} from './shared'

/* ── Motherboard ──────────────────────────────────────────────────────── */

/**
 * The board, its firmware, and what the maker has published since — for the
 * box's Motherboard tab and a node's alike.
 *
 * Build already names the board. This tab exists for the one question
 * Build refuses to answer — "am I behind?" — and answers it from the maker's
 * list (lib/dashboard/board-releases.ts): MSI's download host, which names
 * every package by board code and version and puts a one-page note at the
 * front of each; Gigabyte's support page, which refuses plain clients and is
 * read by the box's own browser instead. Apple's firmware moves with macOS.
 * For any other maker the tab says there is no feed and leaves the version
 * alone.
 */
export function BoardView({ info }: { info: BoardInfo }) {
  const r = info.releases
  const newest = r.releases[0]
  const verdict: { tone: Tone; label: string } =
    r.make === null
      ? { tone: 'muted', label: 'no feed' }
      : r.releases.length === 0
        ? { tone: 'muted', label: 'no list' }
        : r.behind === null
          ? { tone: 'muted', label: 'not on the list' }
          : r.behind === 0
            ? { tone: 'ok', label: 'newest' }
            : { tone: r.behind >= 4 ? 'bad' : 'warn', label: `${num(r.behind)} behind` }
  const newerThan = (v: string) =>
    r.behind !== null && r.releases.findIndex((x) => x.version === v) < r.behind
  // Only what is ahead of the running firmware, and the running one to
  // anchor it. The releases before it are history the board has already
  // lived through, and a list of twenty-two where three matter buried the
  // three. When nothing could be counted the whole list stands, and the
  // foot says so.
  const matched = r.running !== null && r.releases.some((x) => x.version === r.running)
  const shown = r.behind === null ? r.releases : r.releases.slice(0, r.behind + (matched ? 1 : 0))
  const part = partMatching('board', info.model)
  // Gigabyte writes no revision into SMBIOS ("x.x"); its firmware line does
  // the telling — the FA series ships on the rev 1.2 board, the F series
  // on rev 1.0/1.1 and the V2 — so the revision is inferred rather than
  // asked for, and the aside says it was.
  const revision = revisionOf(info)

  return (
    <BoardGrid>
      <Board
        title="The board"
        icon="hash"
        span={4}
        aside={
          <span className={NOTE}>
            {revision === null
              ? 'revision unstated'
              : revision.inferred
                ? `rev ${revision.rev}, from the firmware line`
                : `rev ${revision.rev}`}
          </span>
        }
      >
        <div className={PART}>
          {part !== null && <PartPhoto part={part} />}
          <div className={PART_ID}>
            <strong className={PART_NAME}>{info.model ?? DASH}</strong>
            <span className={PART_DETAIL}>
              {shortVendor(info.vendor)}
              {info.form !== null && ` · ${info.form}`}
            </span>
          </div>
        </div>
        <Facts
          rows={[
            { k: 'Firmware', v: <span className={MONO}>{info.bios.version ?? DASH}</span> },
            { k: 'Built', v: info.bios.date ?? DASH },
            { k: 'Firmware by', v: shortVendor(info.bios.vendor) },
            { k: 'Maker', v: shortVendor(info.vendor) },
          ]}
        />
        <p className={FOOT}>
          {r.make === 'apple'
            ? 'Apple’s boards have no BIOS: the firmware is part of macOS and moves with it, so the version here is the last system update’s.'
            : r.make === 'gigabyte'
              ? 'Gigabyte writes no revision into SMBIOS (it says “x.x”); the firmware series tells it instead — an FA-series BIOS is the rev 1.2 board, an F-series the earlier one.'
              : 'From SMBIOS, which is what the firmware was told at the factory. The spec sheet is on Build.'}
        </p>
      </Board>

      <Board
        title="Firmware"
        icon="◈"
        span={8}
        aside={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
      >
        <Measures
          items={[
            { k: 'running', v: r.running ?? info.bios.version ?? DASH },
            { k: 'newest', v: newest?.version ?? DASH },
            { k: 'published', v: newest?.date ?? DASH },
            { k: 'newer', v: r.behind === null ? DASH : num(r.behind) },
          ]}
        />
        <p className={FOOT}>
          {r.make === 'msi' && r.error === null && r.releases.length > 0 && (
            <>
              Read from MSI&rsquo;s download host{r.checkedAt !== null && ` ${ago(r.checkedAt)}`}:
              every package the board&rsquo;s code has, with its date, and the note at the front of
              each. The website would be the obvious source and refuses this box, curl and Chromium
              alike; the packages are plain files.{' '}
              {r.behind !== null && r.behind > 0 && (
                <>
                  Being {num(r.behind)} behind is a fact, not a verdict: a BIOS update on a machine
                  that works is a risk taken for the notes below, and nothing here applies one.
                </>
              )}
            </>
          )}
          {r.make === 'msi' && r.error !== null && <>{r.error}. </>}
          {r.releases.length > 0 && r.behind === null && (
            <>
              The running version {info.bios.version ?? ''} did not match a package name, so nothing
              is counted.{' '}
            </>
          )}
          {r.make === 'gigabyte' && r.releases.length > 0 && (
            <>
              Read from Gigabyte&rsquo;s support page
              {r.checkedAt !== null && ` ${ago(r.checkedAt)}`} by this box&rsquo;s own browser — the
              site refuses every plain client, so the shotter lab reads it, daily and whenever a
              board is first looked at. {r.note}{' '}
              {r.behind !== null && r.behind > 0 && (
                <>
                  Being {num(r.behind)} behind is a fact, not a verdict: nothing here flashes
                  anything.
                </>
              )}
            </>
          )}
          {r.make === 'gigabyte' && r.releases.length === 0 && <>{r.error}</>}
          {r.make === 'apple' && (
            <>{r.error} A pending macOS update there is a pending firmware update here.</>
          )}
          {r.make === null && (
            <>
              No maker recognised from the SMBIOS vendor string, so there is nothing to compare
              against. The version is stated and left alone.
            </>
          )}
        </p>
      </Board>

      <Board
        title={
          r.releases.length === 0
            ? 'Releases'
            : r.behind === null
              ? `${num(r.releases.length)} releases`
              : r.behind === 0
                ? 'Nothing newer'
                : `${num(r.behind)} newer`
        }
        icon="⎌"
        span={12}
        aside={
          r.source === null ? undefined : (
            <span className={`${NOTE} ${MONO}`}>{r.source.replace(/^https?:\/\//, '')}</span>
          )
        }
      >
        {r.releases.length === 0 ? (
          <p className={EMPTY}>
            {r.make === 'apple'
              ? 'Apple publishes firmware only inside macOS updates; the machine’s own list is on Updates.'
              : r.make === 'gigabyte'
                ? (r.error ?? 'No list from Gigabyte yet.')
                : r.make === null
                  ? 'No maker feed for this board.'
                  : (r.error ?? 'Nothing read yet.')}
          </p>
        ) : (
          <ul className={LIST}>
            {shown.map((rel) => (
              <li key={rel.version} className={`${ROW} flex-wrap`}>
                <span className={`${ROW_MAIN} flex min-w-0 flex-col gap-[0.15rem]`}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={MONO}>{rel.version}</span>
                    {rel.version === r.running && <Chip tone="ok">running</Chip>}
                    {newerThan(rel.version) && <Chip tone="warn">newer</Chip>}
                    <span className={NOTE}>{rel.date ?? DASH}</span>
                  </span>
                  {rel.notes.length === 0 ? (
                    <span className={NOTE}>no note in the package</span>
                  ) : (
                    <span className="flex flex-col gap-[0.1rem] text-[0.8rem] text-foreground leading-[1.45]">
                      {rel.notes.map((n) => (
                        <span key={n}>{n}</span>
                      ))}
                    </span>
                  )}
                </span>
                <span className={ROW_SIDE}>
                  {rel.url === null ? (
                    bytes(rel.sizeBytes)
                  ) : (
                    <a href={rel.url} target="_blank" rel="noreferrer" className={MONO}>
                      {bytes(rel.sizeBytes)} ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={FOOT}>
          {r.releases.length > 0 && r.behind !== null && (
            <>
              What is ahead of the running firmware, newest first
              {matched ? ', down to the one it runs' : ''}; the{' '}
              {num(r.releases.length - shown.length)} before it are history the board has already
              lived through and are left out.{' '}
            </>
          )}
          {r.releases.length > 0 && r.behind === null && (
            <>The whole list, since nothing could be counted against the running version. </>
          )}
          {r.make === 'msi'
            ? 'The maker’s own words, English section only. Every package is a link; flashing one is done at the machine, from its BIOS, and is not this page’s to start.'
            : r.make === 'gigabyte'
              ? 'Gigabyte’s own notes. Every package is a link; flashing one is done at the machine, from Q-Flash, and is not this page’s to start.'
              : r.make === 'apple'
                ? 'The Mac’s pending and installed system updates are the firmware history that exists.'
                : 'Nothing to list.'}
        </p>
      </Board>
    </BoardGrid>
  )
}

/** A node's Motherboard tab: the same view over its telemetry. */
export function NodeBoardView({ d }: { d: NodeSystemData }) {
  const t = d.telemetry
  if (t === null) return null
  if (d.releases === null) {
    return (
      <p className={EMPTY}>
        The maker&rsquo;s list was not read for this page. Open the tab again from{' '}
        <Link
          to="/c/$category"
          params={{ category: 'system' }}
          search={{ tab: 'board', machine: d.node.id }}
        >
          Motherboard
        </Link>
        .
      </p>
    )
  }
  return (
    <BoardView
      info={{
        vendor: t.machine.boardManufacturer ?? t.machine.manufacturer,
        model: t.machine.boardProduct ?? t.machine.model,
        revision: null,
        form: t.machine.form,
        bios: {
          vendor: t.machine.biosVendor,
          version: t.machine.biosVersion,
          date: t.machine.biosDate,
        },
        releases: d.releases,
      }}
    />
  )
}

/** The board's revision: as SMBIOS states it, or as the firmware line implies it. */
function revisionOf(info: BoardInfo): { rev: string; inferred: boolean } | null {
  if (info.revision !== null && info.revision !== 'x.x' && info.revision.trim() !== '') {
    return { rev: info.revision, inferred: false }
  }
  if (info.releases.make === 'gigabyte') {
    const g = gigabyteRevision(info.bios.version)
    if (g !== null) return { rev: g.rev, inferred: true }
  }
  return null
}
