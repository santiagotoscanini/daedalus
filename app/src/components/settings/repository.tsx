import type { BoxSettings } from '../../core/settings/types'
import type { SiteEdit, SiteState } from '../../core/site'
import type { RepoFacts } from '../../host/contract/domains/repo'
import { Chip } from '../viz'
import { Commit, Mono, Section, SourceNote, Unset, Value } from './shared'
import { SiteSection } from './site-dir'

// The configuration repository, and the one directory in it that daedalus
// writes.
//
// `site/` is data, not code: what this box is, as JSON, and the document nix
// defines the site constants from (nix/platform/site.nix). So the interesting
// row is not the commit; it is whether each file is what this box would write
// now (core/site siteState compares it with the desired document).
//
// Source control is the operator's. What the host cannot delegate is staging:
// a flake sees only tracked files, so a file written here and never added
// fails the very rebuild it was written for. The tab says which state the
// directory is in, in one sentence each (SourceControl).

export function Repository({
  settings,
  site,
  edit,
}: {
  settings: BoxSettings
  /** Null while the digest comparison is still in flight. */
  site: SiteState | null
  edit: SiteEdit
}) {
  const r = settings.repository
  const f = r.facts
  const dirty = f.tree.modified + f.tree.untracked > 0
  const running = r.runningRevision?.replace(/-dirty$/, '') ?? null
  const headRuns = running !== null && f.head !== null && f.head.rev === running

  return (
    <div className="flex flex-col gap-6">
      <SiteSection dir={f.site} site={site} edit={edit} git={r.git} />

      <Section
        title="Configuration repository"
        icon="/icon-github.svg"
        mono
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
                <span className="text-[0.78rem] text-subdued">
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
          <p className="m-0 text-[0.78rem] text-subdued">
            An untracked file is invisible to a rebuild — the flake only sees what git tracks. Add
            it before building, or the build fails with "file not found".
          </p>
        )}
        {f.upstream !== null && f.upstream.ahead > 0 && (
          <p className="m-0 text-[0.78rem] text-subdued">
            Commits not yet pushed exist only on this disk, which is not snapshotted. Push.
          </p>
        )}
      </Section>

      <Section
        title="What runs"
        icon="/icon-nixos.webp"
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
                  <span className="text-[0.78rem] text-subdued">{r.applyStatus.phase}</span>
                )}
              </span>
            ),
          },
        ]}
      >
        {running !== null && !headRuns && f.head !== null && (
          <p className="m-0 text-[0.78rem] text-subdued">
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
