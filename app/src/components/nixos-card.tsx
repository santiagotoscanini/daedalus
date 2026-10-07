import { useEffect, useState } from 'react'
import type { NixosRelease } from '../core/settings/types'
import type { NixosFacts } from '../host/contract/domains/site'
import { num } from '../lib/format'
import { builtOn, type Support } from '../lib/nixos'
import { fetchNixosRelease } from '../server/updates'
import { Ago } from './ago'
import { ReleaseNotes, UpgradeChain } from './release-notes'
import { CAPTION, MONO, NOTE } from './tokens'
import { Skeleton } from './ui/skeleton'
import { Board, Chip, Facts } from './viz'

// The NixOS release this generation was built with — on System › Updates
// beside the engine's pin, because it is the third thing on the box that can
// move: the images by digest, the engine by rev, nixpkgs by channel commit
// (weekly, by the autoupgrade timer) and by release (a hand edit to the
// flake's input, and the one this card exists to argue for or against).
//
// Two halves. The facts —
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

const ASIDE = 'ml-2 text-muted-foreground'

export function NixosCard({ facts }: { facts: NixosFacts }) {
  const live = useNixosRelease()
  const release = live.state === 'answered' ? live.release : null

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
        <p className={CAPTION}>
          {facts.release} stopped receiving fixes on {release.support.eol}. Moving to {next} is a
          change to the flake's nixpkgs input and a rebuild; its backward incompatibilities, below,
          are what to read first.
        </p>
      )}

      {live.state === 'failed' && (
        <p className={CAPTION}>
          Could not ask where the release stands{live.reason !== '' && `: ${live.reason}`}.
        </p>
      )}

      {release !== null && (
        <div className="flex flex-col gap-3">
          {release.notes.length === 0 ? (
            <p className={NOTE}>{release.note ?? 'no release notes could be read'}</p>
          ) : (
            <>
              {next !== null && <UpgradeChain behind={[next]} />}
              <ReleaseNotes releases={release.notes} running={facts.release} />
            </>
          )}
          <p className={CAPTION}>
            {release.note !== null && `${release.note}. `}
            From the NixOS manual's release notes in nixpkgs, first paragraphs only; open one for
            the full list. Asked <Ago at={release.checkedAt} />, at most hourly.
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
  // Supported is the norm: a quiet line. Only ending or ended is a chip.
  return <span className={NOTE}>supported until {support.eol}</span>
}

function Channel({ live }: { live: Live }) {
  if (live.state === 'asking') return <Skeleton className="h-4 w-36" />
  if (live.state === 'failed') return <span className={NOTE}>not asked</span>
  const c = live.release.channel
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className={MONO}>{c.branch}</span>
        {c.newer === null ? (
          <Chip tone="muted">not compared</Chip>
        ) : c.newer === 0 ? (
          <span className={NOTE}>no newer commits</span>
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
  if (l.cycle === facts.release) return <span className="text-muted-foreground">this release</span>
  const eol = live.release.latestSupport?.eol ?? null
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={MONO}>
        {l.cycle}
        {l.codename !== '' && <span className={ASIDE}>{l.codename}</span>}
      </span>
      <span className={NOTE}>released {l.releaseDate}</span>
      {eol !== null && <span className={NOTE}>supported until {eol}</span>}
    </span>
  )
}
