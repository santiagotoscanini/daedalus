import type { BoxSettings } from '../../core/settings/types'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Chip } from '../viz'
import { Commit, Mono, Section, SourceNote, Unset, Value } from './shared'

// The configuration repository — today the whole truth about the box, and
// after Phase 3 the flake that imports the engine and pins the site. What
// this tab says is what the host's snapshot says; the container never sees
// the repo itself.

export function Repository({ settings }: { settings: BoxSettings }) {
  const r = settings.repository
  const f = r.facts
  const dirty = f.tree.modified + f.tree.untracked > 0
  const running = r.runningRevision?.replace(/-dirty$/, '') ?? null
  const headRuns = running !== null && f.head !== null && f.head.rev === running

  return (
    <div className="flex flex-col gap-6">
      <Alert>
        <AlertTitle>Site repository: not configured</AlertTitle>
        <AlertDescription>
          The JSON repository daedalus manages — site, apps, secrets — does not exist yet. Until it
          is configured from this page, the configuration repository below is the whole truth, and
          every Apply is a commit to it.
        </AlertDescription>
      </Alert>

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
          {
            k: 'Against origin',
            v:
              f.upstream === null ? (
                <Unset label="no upstream" />
              ) : f.upstream.ahead === 0 && f.upstream.behind === 0 ? (
                <span className="inline-flex items-center gap-2">
                  <Chip tone="ok">in sync</Chip>
                  <Mono>{f.upstream.ref}</Mono>
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <Chip tone={f.upstream.ahead > 0 ? 'warn' : 'info'}>
                    {[
                      f.upstream.ahead > 0 && `${String(f.upstream.ahead)} ahead`,
                      f.upstream.behind > 0 && `${String(f.upstream.behind)} behind`,
                    ]
                      .filter((s): s is string => typeof s === 'string')
                      .join(', ')}
                  </Chip>
                  <Mono>{f.upstream.ref}</Mono>
                </span>
              ),
          },
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
