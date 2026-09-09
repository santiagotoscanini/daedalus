import { useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'
import type { BoxSettings } from '../../core/settings/types'
import type { SiteFileView, SiteState } from '../../core/site'
import type { RepoFacts, SiteDir } from '../../lib/contract/domains/repo'
import { fetchSiteRequestStatus, setSiteCommit, writeSiteFiles } from '../../server/site'
import { usePolledStatus } from '../status'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { Switch } from '../ui/switch'
import { Chip } from '../viz'
import { Commit, Mono, Section, SourceNote, Unset, Value } from './shared'

// The configuration repository, and the one directory in it that daedalus
// writes.
//
// `site/` is data, not code: what this box is, as JSON. Nothing is built from
// it yet — it is written FROM the running configuration, and it has to be
// provably identical to that for a while before anything is allowed to build
// from it instead. So the interesting row is not the commit; it is whether the
// file is what this box would write now.
//
// Source control is the operator's. What the host cannot delegate is staging:
// a flake sees only tracked files, so a file written here and never added
// fails the very rebuild it was written for. The tab says which of the three
// states the directory is in, in one sentence each.

export function Repository({
  settings,
  site,
}: {
  settings: BoxSettings
  /** Null while the digest comparison is still in flight. */
  site: SiteState | null
}) {
  const r = settings.repository
  const f = r.facts
  const dirty = f.tree.modified + f.tree.untracked > 0
  const running = r.runningRevision?.replace(/-dirty$/, '') ?? null
  const headRuns = running !== null && f.head !== null && f.head.rev === running

  return (
    <div className="flex flex-col gap-6">
      <SiteSection dir={f.site} site={site} />

      <Section
        title="Configuration repository"
        description="The flake a rebuild reads. Facts, not the repo: the tree is never mounted into this container."
        rows={[
          { k: 'Path', v: <Value v={f.path} /> },
          { k: 'Remote', v: <Value v={f.remote} /> },
          { k: 'Branch', v: <Value v={f.branch} /> },
          {
            k: 'Head',
            v:
              f.head === null ? (
                <Unset />
              ) : (
                <Commit rev={f.head.rev} subject={f.head.subject} at={f.head.committedAt} />
              ),
          },
          {
            k: 'Working tree',
            v: dirty ? (
              <span className="inline-flex items-center gap-2">
                <Chip tone="warn">dirty</Chip>
                <span className="text-[0.78rem] text-(--text-muted)">
                  {[
                    f.tree.modified > 0 && `${String(f.tree.modified)} modified`,
                    f.tree.untracked > 0 && `${String(f.tree.untracked)} untracked`,
                  ]
                    .filter((s): s is string => typeof s === 'string')
                    .join(', ')}
                </span>
              </span>
            ) : (
              <Chip tone="ok">clean</Chip>
            ),
          },
          { k: 'Against origin', v: <AgainstOrigin upstream={f.upstream} /> },
        ]}
      >
        {f.tree.untracked > 0 && (
          <p className="m-0 text-[0.78rem] text-(--text-muted)">
            An untracked file is invisible to a rebuild — the flake only sees what git tracks. Add
            it before building, or the build fails with "file not found".
          </p>
        )}
        {f.upstream !== null && f.upstream.ahead > 0 && (
          <p className="m-0 text-[0.78rem] text-(--text-muted)">
            Commits not yet pushed exist only on this disk, which is not snapshotted. Push.
          </p>
        )}
      </Section>

      <Section
        title="What runs"
        description="The generation that is live now, against the commit at the head of the repository."
        rows={[
          {
            k: 'Running generation',
            v:
              running === null ? (
                <Unset label="no revision recorded" />
              ) : (
                <span className="inline-flex items-center gap-2">
                  {headRuns ? <Chip tone="ok">is HEAD</Chip> : <Chip tone="warn">behind HEAD</Chip>}
                  <Mono>{running.slice(0, 10)}</Mono>
                </span>
              ),
          },
          {
            k: 'Last Apply',
            v:
              f.lastApply === null ? (
                <Unset label="never" />
              ) : (
                <Commit
                  rev={f.lastApply.rev}
                  subject={f.lastApply.subject}
                  at={f.lastApply.committedAt}
                />
              ),
          },
          {
            k: 'Apply agent',
            v: (
              <span className="inline-flex items-center gap-2">
                <Chip
                  tone={
                    r.applyStatus.state === 'failed'
                      ? 'bad'
                      : r.applyStatus.state === 'running'
                        ? 'info'
                        : 'muted'
                  }
                >
                  {r.applyStatus.state}
                </Chip>
                {r.applyStatus.phase !== '' && (
                  <span className="text-[0.78rem] text-(--text-muted)">{r.applyStatus.phase}</span>
                )}
              </span>
            ),
          },
        ]}
      >
        {running !== null && !headRuns && f.head !== null && (
          <p className="m-0 text-[0.78rem] text-(--text-muted)">
            The repository has moved past what is running. Nothing is wrong — a commit without a
            rebuild is normal — but the box does not yet do what HEAD says.
          </p>
        )}
      </Section>

      <SourceNote
        meta={r.meta}
        file="/repo/repo.json"
        producer="daedalus-repo-snapshot every 5 minutes"
      />
    </div>
  )
}

function AgainstOrigin({ upstream }: { upstream: RepoFacts['upstream'] }) {
  if (upstream === null) return <Unset label="no upstream" />
  if (upstream.ahead === 0 && upstream.behind === 0) {
    return (
      <span className="inline-flex items-center gap-2">
        <Chip tone="ok">in sync</Chip>
        <Mono>{upstream.ref}</Mono>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Chip tone={upstream.ahead > 0 ? 'warn' : 'info'}>
        {[
          upstream.ahead > 0 && `${String(upstream.ahead)} ahead`,
          upstream.behind > 0 && `${String(upstream.behind)} behind`,
        ]
          .filter((s): s is string => typeof s === 'string')
          .join(', ')}
      </Chip>
      <Mono>{upstream.ref}</Mono>
    </span>
  )
}

/* ── The site directory ────────────────────────────────────────────────── */

/**
 * One of three sentences, and the switch that only makes sense in one of
 * them. The sentences are the whole point: each state has a consequence the
 * operator should know about before pressing anything.
 */
function SourceControl({ dir, site }: { dir: SiteDir; site: SiteState | null }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [commit, setCommit] = useState(site?.commit ?? false)
  const versioned = dir.toplevel !== null

  return (
    <div className="flex flex-col gap-3 border-(--border-soft) border-t pt-4">
      <p className="m-0 text-[0.82rem] leading-[1.55]">
        {!dir.exists ? (
          <>
            The directory does not exist yet. Writing it for the first time creates it inside the
            configuration repository above
            {dir.path !== '' && (
              <>
                {' '}
                at <Mono>{dir.path}</Mono>
              </>
            )}
            .
          </>
        ) : !versioned ? (
          <>
            <Chip tone="warn">not under source control</Chip> The directory is not inside a git work
            tree. daedalus writes the files and stops; this disk holds the only copy of what it
            wrote.
          </>
        ) : !dir.inThisRepo ? (
          <>
            <Chip tone="warn">another repository</Chip> The directory is under source control in{' '}
            <Mono>{dir.toplevel}</Mono>, not in the configuration repository above. daedalus stages
            what it writes there; a rebuild of this flake cannot see it.
          </>
        ) : commit ? (
          <>
            <Chip tone="ok">committed on every write</Chip> After each write daedalus commits,
            scoped to <Mono>site/</Mono>, and pushes if the branch has an upstream.
          </>
        ) : (
          <>
            <Chip tone="info">staged, not committed</Chip> daedalus stages what it writes — a flake
            sees only tracked files, so that part is not optional — and leaves committing to you.
            Your next <Mono>git commit</Mono> will sweep those files in.
          </>
        )}
      </p>

      {versioned && dir.inThisRepo && (
        <label className="flex items-center gap-3 text-[0.82rem]" htmlFor="site-commit">
          <Switch
            id="site-commit"
            checked={commit}
            disabled={site === null || pending}
            onCheckedChange={(v) => {
              setCommit(v)
              start(async () => {
                await setSiteCommit({ data: v })
                await router.invalidate()
              })
            }}
          />
          Commit after every write
        </label>
      )}
    </div>
  )
}

function SiteSection({ dir, site }: { dir: SiteDir; site: SiteState | null }) {
  return (
    <>
      {!dir.exists && (
        <Alert>
          <AlertTitle>Site directory: not written yet</AlertTitle>
          <AlertDescription>
            <code>site/</code> is the one directory in the configuration repository that daedalus
            writes — what this box is, as JSON. Nothing is built from it yet: it is written from the
            running configuration, so writing it changes nothing about how this box runs.
          </AlertDescription>
        </Alert>
      )}

      <Section
        title="Site"
        description="What this box is, as data. Written by daedalus into the configuration repository; nothing is built from it yet."
        rows={[{ k: 'Path', v: <Value v={dir.path} /> }]}
      >
        <SiteFiles dir={dir} site={site} />
        <SourceControl dir={dir} site={site} />
        <WriteControl />
      </Section>
    </>
  )
}

const STATUS_TONE: Record<SiteFileView['status'], 'ok' | 'warn' | 'info' | 'muted'> = {
  clean: 'ok',
  staged: 'info',
  modified: 'info',
  untracked: 'warn',
  unversioned: 'muted',
  absent: 'muted',
}

function SiteFiles({ dir, site }: { dir: SiteDir; site: SiteState | null }) {
  if (!dir.exists) return null
  if (site === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {site.files.map((file) => (
        <div
          key={file.name}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
        >
          <Mono>{file.name}</Mono>
          <span className="inline-flex items-center gap-2">
            {file.current === false && <Chip tone="warn">differs</Chip>}
            {file.current === true && <Chip tone="ok">current</Chip>}
            <Chip tone={STATUS_TONE[file.status]}>{file.status}</Chip>
          </span>
        </div>
      ))}
      {site.files.some((f) => f.status === 'untracked') && (
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          An untracked file is invisible to a rebuild. This should not happen — daedalus stages what
          it writes — so something else put it there, or a <Mono>git reset</Mono> undid the add.
        </p>
      )}
      {site.files.some((f) => f.current === false) && (
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          <Mono>site.json</Mono> is not what this box would write now — the configuration changed
          since, or it was edited by hand. Writing it again brings the two back together; nothing is
          rebuilt.
        </p>
      )}
      {site.files.find((f) => f.name === 'apps.json')?.status === 'absent' && (
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          <Mono>apps.json</Mono> is written only by an Apply, and from here only once nix reads the
          registry from this directory.
        </p>
      )}
    </div>
  )
}

const IDLE = {
  id: null,
  action: null,
  state: 'idle' as const,
  phase: '',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
  commit: null,
}

function WriteControl() {
  const router = useRouter()
  const [refusal, setRefusal] = useState('')
  const { status, running, start } = usePolledStatus({
    initial: IDLE,
    fetch: fetchSiteRequestStatus,
    // The host refreshes the repository snapshot BEFORE it reports done, so
    // the facts this re-reads are already current.
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        disabled={running}
        onClick={() => {
          setRefusal('')
          start(async () => {
            const out = await writeSiteFiles()
            if (!out.ok) {
              setRefusal(out.reason)
              return null
            }
            return out.id
          })
        }}
      >
        {running ? (status.phase === '' ? 'working…' : `${status.phase}…`) : 'Write site.json'}
      </Button>
      {refusal !== '' && <span className="text-[0.78rem] text-danger">{refusal}</span>}
      {refusal === '' && status.state === 'failed' && (
        <span className="text-[0.78rem] text-danger">{status.error}</span>
      )}
      {refusal === '' && status.state === 'done' && status.detail !== '' && (
        <span className="text-[0.78rem] text-(--text-muted)">{status.detail}</span>
      )}
    </div>
  )
}
