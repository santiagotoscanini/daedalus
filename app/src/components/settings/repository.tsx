import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { BoxSettings } from '../../core/settings/types'
import type { MirrorFile, SiteMirror } from '../../core/site'
import type { SiteRepo } from '../../lib/contract/domains/repo'
import { bytes as fmtBytes } from '../../lib/format'
import { fetchSiteRequestStatus, initSiteRepo } from '../../server/site'
import { usePolledStatus } from '../status'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { Chip } from '../viz'
import { Commit, Mono, Section, SourceNote, Unset, Value } from './shared'

// The two repositories this box is described by.
//
// The SITE repository is the one daedalus writes: plain JSON, no code, and
// the only thing a web UI has any business committing to. Nothing reads it
// yet — it is a mirror of what the running system was built from, and it has
// to be provably identical to that for a while before anything is allowed to
// build from it instead. Which is why the interesting row on this tab is not
// the commit; it is whether the bytes agree.
//
// The CONFIGURATION repository below is the flake a rebuild reads. What this
// tab says about either is what the host's snapshot says; the container never
// mounts either tree.

export function Repository({
  settings,
  mirror,
}: {
  settings: BoxSettings
  /** Null while the byte comparison is still in flight. */
  mirror: SiteMirror | null
}) {
  const r = settings.repository
  const f = r.facts
  const site = f.site
  const dirty = f.tree.modified + f.tree.untracked > 0
  const running = r.runningRevision?.replace(/-dirty$/, '') ?? null
  const headRuns = running !== null && f.head !== null && f.head.rev === running

  return (
    <div className="flex flex-col gap-6">
      {site.state === 'ready' ? (
        <ConfiguredSite site={site} mirror={mirror} />
      ) : (
        <NewSite site={site} settings={settings} />
      )}

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

function AgainstOrigin({ upstream }: { upstream: SiteRepo['upstream'] }) {
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

/* ── Before it exists ──────────────────────────────────────────────────── */

/**
 * The call to action, and the whole of what this box will do when it is
 * pressed — including the part that leaves the machine.
 *
 * Creating a repository on somebody's GitHub account is the first thing
 * daedalus does that is visible outside the house, so it is opt-in, spelled
 * out, and private. Leaving the remote empty is a real answer: a repository
 * with no origin is still an audit trail, and one can be added later.
 */
function NewSite({ site, settings }: { site: SiteRepo; settings: BoxSettings }) {
  const suggested = `${settings.general.owner}/${settings.general.hostname}-site`

  return (
    <>
      <Alert>
        <AlertTitle>Site repository: not configured</AlertTitle>
        <AlertDescription>
          The JSON repository daedalus manages — what this box is, its app registry, and later its
          encrypted secrets — does not exist yet. Until it does, the configuration repository below
          is the whole truth and every Apply is a commit to it. Creating it changes nothing about
          how this box is built: it is written from the running configuration, and nothing reads it
          back.
        </AlertDescription>
      </Alert>

      <Section
        title="Site repository"
        description="Created here, on this disk, and pushed to a remote only if you name one."
        rows={[
          { k: 'Path', v: <Value v={site.path} /> },
          {
            k: 'State',
            v:
              site.state === 'not-a-repo' ? (
                <span className="inline-flex items-center gap-2">
                  <Chip tone="warn">not a repository</Chip>
                  <span className="text-[0.78rem] text-(--text-muted)">
                    a directory is there, git is not
                  </span>
                </span>
              ) : (
                <Chip tone="muted">does not exist</Chip>
              ),
          },
        ]}
      >
        <InitForm suggested={suggested} verb="Initialize" />
      </Section>
    </>
  )
}

/* ── Once it exists ────────────────────────────────────────────────────── */

function ConfiguredSite({ site, mirror }: { site: SiteRepo; mirror: SiteMirror | null }) {
  return (
    <Section
      title="Site repository"
      description="What this box is, as data. Written by daedalus; nothing is built from it yet."
      rows={[
        { k: 'Path', v: <Value v={site.path} /> },
        { k: 'Remote', v: <Value v={site.remote} /> },
        { k: 'Branch', v: <Value v={site.branch} /> },
        {
          k: 'Head',
          v:
            site.head === null ? (
              <Unset label="no commits yet" />
            ) : (
              <Commit rev={site.head.rev} subject={site.head.subject} at={site.head.committedAt} />
            ),
        },
        { k: 'Against origin', v: <AgainstOrigin upstream={site.upstream} /> },
      ]}
    >
      <Mirror mirror={mirror} />
      <InitForm suggested="" verb="Re-sync" />
    </Section>
  )
}

/**
 * Whether the committed files are the files this box would write.
 *
 * The comparison is by sha256 of the exact bytes, both sides — daedalus
 * hashes its own render, the host publishes a hash of the committed file, and
 * neither reads the other's copy. "In sync" is therefore a claim about the
 * file, not about when it was last written.
 */
function Mirror({ mirror }: { mirror: SiteMirror | null }) {
  if (mirror === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {mirror.files.map((file) => (
        <MirrorRow key={file.name} file={file} />
      ))}
      <p className="m-0 text-[0.78rem] text-(--text-muted)">
        {mirror.inSync
          ? 'Byte-identical to what this box would write now. That is the whole claim the mirror makes, and the reason it is safe to build from later.'
          : 'The repository differs from what this box would write now. Re-sync commits the difference; nothing is rebuilt either way.'}
      </p>
    </div>
  )
}

function MirrorRow({ file }: { file: MirrorFile }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <Mono>{file.name}</Mono>
      <span className="inline-flex items-center gap-2">
        <Chip tone={file.state === 'in-sync' ? 'ok' : file.state === 'missing' ? 'warn' : 'info'}>
          {file.state === 'in-sync' ? 'in sync' : file.state}
        </Chip>
        <span className="text-[0.74rem] text-(--dim)">
          {file.committed === null
            ? `would write ${fmtBytes(file.rendered.bytes)}`
            : file.state === 'in-sync'
              ? fmtBytes(file.committed.bytes)
              : `${fmtBytes(file.committed.bytes)} committed, ${fmtBytes(file.rendered.bytes)} rendered`}
        </span>
      </span>
    </div>
  )
}

/* ── The action ────────────────────────────────────────────────────────── */

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

function InitForm({ suggested, verb }: { suggested: string; verb: string }) {
  const [remote, setRemote] = useState(suggested)
  const [create, setCreate] = useState(false)
  const [refusal, setRefusal] = useState('')
  const first = suggested !== ''

  const router = useRouter()
  const { status, running, start } = usePolledStatus({
    initial: IDLE,
    fetch: fetchSiteRequestStatus,
    // The host refreshes the repository snapshot BEFORE it reports done, so
    // the facts this re-reads are already current — the tab does not spend
    // five minutes telling the operator that the repository they just made
    // does not exist.
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <form
      className="flex flex-col gap-4 border-(--border-soft) border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        setRefusal('')
        start(async () => {
          const out = await initSiteRepo({ data: { remote: remote.trim(), createRemote: create } })
          if (!out.ok) {
            setRefusal(out.reason)
            return null
          }
          return out.id
        })
      }}
    >
      {first && (
        <>
          <Field>
            <FieldLabel htmlFor="site-remote">Remote</FieldLabel>
            <Input
              id="site-remote"
              value={remote}
              placeholder="owner/name"
              disabled={running}
              onChange={(e) => {
                setRemote(e.target.value)
              }}
            />
            <FieldDescription>
              Where to push it, written <code>owner/name</code>. Leave it empty for a repository
              that lives only on this disk — which is not snapshotted, so it would be the only copy.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <FieldLabel htmlFor="site-create" className="order-2 font-normal">
              Create it on GitHub if it does not exist. It will be private.
            </FieldLabel>
            <Checkbox
              id="site-create"
              className="order-1"
              checked={create}
              disabled={running || remote.trim() === ''}
              onCheckedChange={(v) => {
                setCreate(v === true)
              }}
            />
          </Field>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={running}>
          {running ? (status.phase === '' ? 'working…' : `${status.phase}…`) : verb}
        </Button>
        {refusal !== '' && <span className="text-[0.78rem] text-danger">{refusal}</span>}
        {refusal === '' && status.state === 'failed' && (
          <span className="text-[0.78rem] text-danger">{status.error}</span>
        )}
        {refusal === '' && status.state === 'done' && status.detail !== '' && (
          <span className="text-[0.78rem] text-(--text-muted)">{status.detail}</span>
        )}
      </div>
    </form>
  )
}
