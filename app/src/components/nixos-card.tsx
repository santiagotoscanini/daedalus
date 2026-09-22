import { useEffect, useState } from 'react'
import type { NixosRelease } from '../core/settings/types'
import type { NixosFacts } from '../host/contract/domains/site'
import { num, since } from '../lib/format'
import { builtOn, type Support } from '../lib/nixos'
import { fetchNixosRelease } from '../server/updates'
import { ReleaseNotes, UpgradeChain } from './release-notes'
import { FOOT, MONO, NOTE } from './tokens'
import { Skeleton } from './ui/skeleton'
import { Board, Chip, Facts } from './viz'

// The NixOS release this generation was built with — on System › Updates
// beside the engine's pin, because it is the third thing on the box that can
// move: the images by digest, the engine by rev, nixpkgs by channel commit
// (weekly, by the autoupgrade timer) and by release (a hand edit to the
// flake's input, and the one this card exists to argue for or against).
//
// Two halves, like the engine card's neighbours on this page. The facts —
// release, nixpkgs commit, kernel, state version — come from the site export
// with the rest of the tab's loader, at no network cost. Where the release
// stands (support window, the channel's newer commits, the latest release,
// the notes) asks endoflife.date and GitHub, cached hourly on the server, and
// is fetched from here on mount so the tab never waits on them: the same
// on-demand shape as a container row's changelog.

/** Where the release stands, or the two states before an answer. */
type Live =
  | { state: 'asking' }
  | { state: 'failed'; reason: string }
  | { state: 'answered'; release: NixosRelease }

function useNixosRelease(): Live {
  const [live, setLive] = useState<Live>({ state: 'asking' })
  useEffect(() => {
    let cancelled = false
    fetchNixosRelease()
      .then((release) => {
        if (!cancelled) setLive({ state: 'answered', release })
      })
      .catch((e: unknown) => {
        if (!cancelled) setLive({ state: 'failed', reason: e instanceof Error ? e.message : '' })
      })
    return () => {
      cancelled = true
    }
  }, [])
  return live
}

const ASIDE = 'ml-2 text-(--dim)'

export function NixosCard({
  facts,
  version,
}: {
  facts: NixosFacts | null
  /** The version string alone, for an export older than the release facts. */
  version: string | null
}) {
  const live = useNixosRelease()
  const release = live.state === 'answered' ? live.release : null

  if (facts === null) {
    return (
      <Board title="NixOS" span={12}>
        <Facts rows={[{ k: 'Version', v: <span className={MONO}>{version ?? '—'}</span> }]} />
        <p className={FOOT}>
          The export names the version only. The release, its channel and its support window arrive
          with the next rebuild.
        </p>
      </Board>
    )
  }

  const next =
    release?.latest !== null &&
    release?.latest !== undefined &&
    release.latest.cycle !== facts.release
      ? release.latest.cycle
      : null
  const day = builtOn(facts.version)

  return (
    <Board
      title="NixOS"
      span={12}
      aside={
        live.state === 'asking' ? (
          <Skeleton className="h-4 w-28" />
        ) : (
          <SupportChip support={release?.support ?? null} />
        )
      }
    >
      <Facts
        rows={[
          {
            k: 'Release',
            v: (
              <span className={MONO}>
                {facts.release}
                {facts.codeName !== '' && <span className={ASIDE}>{facts.codeName}</span>}
              </span>
            ),
          },
          {
            k: 'nixpkgs',
            v:
              facts.revision === null ? (
                <span className={NOTE}>not a git input</span>
              ) : (
                <span className={MONO}>
                  <a
                    href={`https://github.com/NixOS/nixpkgs/commit/${facts.revision}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {facts.revision.slice(0, 10)}
                  </a>
                  {day !== null && <span className={ASIDE}>{day}</span>}
                </span>
              ),
          },
          { k: 'Channel', v: <Channel live={live} /> },
          { k: 'Latest release', v: <Latest facts={facts} live={live} /> },
          { k: 'Kernel', v: <span className={MONO}>{facts.kernel}</span> },
          { k: 'State version', v: <span className={MONO}>{facts.stateVersion}</span> },
        ]}
      />

      {release?.support?.state === 'ended' && next !== null && (
        <p className={`${NOTE} mt-3`}>
          {facts.release} stopped receiving fixes on {release.support.eol}. Moving to {next} is a
          change to the flake's nixpkgs input and a rebuild; its backward incompatibilities, below,
          are what to read first.
        </p>
      )}

      {live.state === 'failed' && (
        <p className={`${NOTE} mt-3`}>
          Could not ask where the release stands{live.reason !== '' && `: ${live.reason}`}.
        </p>
      )}

      {release !== null && (
        <div className="mt-4">
          {release.notes.length === 0 ? (
            <p className={NOTE}>{release.note ?? 'no release notes could be read'}</p>
          ) : (
            <>
              {next !== null && <UpgradeChain behind={[next]} />}
              <ReleaseNotes releases={release.notes} running={facts.release} />
            </>
          )}
          <p className={FOOT}>
            {release.note !== null && `${release.note}. `}
            From the NixOS manual's release notes in nixpkgs, first paragraphs only; open one for
            the full list. Asked {since((Date.now() - Date.parse(release.checkedAt)) / 1000)}, at
            most hourly.
          </p>
        </div>
      )}
    </Board>
  )
}

function SupportChip({ support }: { support: Support | null }) {
  if (support === null) return <Chip tone="muted">support unknown</Chip>
  if (support.state === 'ended') return <Chip tone="bad">unsupported since {support.eol}</Chip>
  if (support.state === 'ending') {
    return (
      <Chip tone="warn">
        support ends {support.eol} · {support.days}d
      </Chip>
    )
  }
  return <Chip tone="ok">supported until {support.eol}</Chip>
}

function Channel({ live }: { live: Live }) {
  if (live.state === 'asking') return <Skeleton className="h-4 w-36" />
  if (live.state === 'failed') return <span className={NOTE}>not asked</span>
  const c = live.release.channel
  const ended = live.release.support?.state === 'ended'
  return (
    <span className="inline-flex flex-col gap-[0.15rem]">
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className={MONO}>{c.branch}</span>
        {c.newer === null ? (
          <Chip tone="muted">not compared</Chip>
        ) : c.newer === 0 ? (
          <Chip tone={ended ? 'muted' : 'ok'}>no newer commits</Chip>
        ) : (
          <Chip tone="warn">
            {num(c.newer)} newer commit{c.newer === 1 ? '' : 's'}
          </Chip>
        )}
      </span>
      {c.head !== null && <span className={NOTE}>last commit {c.head.date}</span>}
    </span>
  )
}

function Latest({ facts, live }: { facts: NixosFacts; live: Live }) {
  if (live.state === 'asking') return <Skeleton className="h-4 w-36" />
  if (live.state === 'failed') return <span className={NOTE}>not asked</span>
  const l = live.release.latest
  if (l === null) return <span className={NOTE}>endoflife.date did not answer</span>
  if (l.cycle === facts.release) return <Chip tone="ok">this release</Chip>
  const eol = live.release.latestSupport?.eol ?? null
  return (
    <span className="inline-flex flex-col gap-[0.15rem]">
      <span className={MONO}>
        {l.cycle}
        {l.codename !== '' && <span className={ASIDE}>{l.codename}</span>}
      </span>
      <span className={NOTE}>released {l.releaseDate}</span>
      {eol !== null && <span className={NOTE}>supported until {eol}</span>}
    </span>
  )
}
