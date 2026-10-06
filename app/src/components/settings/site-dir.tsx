import { useState } from 'react'
import type { SiteEdit, SiteFileView, SiteState } from '../../core/site'
import type { SiteDir } from '../../host/contract/domains/repo'
import type { GitIdentities, GitIdentity } from '../../host/contract/domains/site'
import { setSiteCommit } from '../../server/site'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Skeleton } from '../ui/skeleton'
import { Switch } from '../ui/switch'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import { NOTE_SHOWN } from './form'
import { Mono, NOTE, Rows, Section, Value } from './shared'
import { type SelectGroupSpec, SiteSelect } from './site-fields'

/* ── The site directory ────────────────────────────────────────────────── */

/**
 * One sentence per state of the directory, and the switch that only makes
 * sense once it is inside the configuration repository. The sentences are the whole point: each state has a consequence the
 * operator should know about before pressing anything.
 */
function SourceControl({ dir, site }: { dir: SiteDir; site: SiteState | null }) {
  const { run, busy: pending } = useAction()
  const [commit, setCommit] = useState(site?.commit ?? false)
  const versioned = dir.toplevel !== null

  return (
    <div className="flex flex-col gap-3 border-hairline border-t pt-4">
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
              run(() => setSiteCommit({ data: v }))
            }}
          />
          Commit after every write
        </label>
      )}
    </div>
  )
}

/**
 * Which configured identity the box's commits are made as. The two come from
 * nix (the box's own, and the operator's git identity); the choice is a
 * site.json field, so it is a pending edit until Apply like the rest.
 */
function CommitAs({ edit, git }: { edit: SiteEdit; git: GitIdentities }) {
  const who = (id: GitIdentity): string => `${id.name} <${id.email}>`
  const groups: SelectGroupSpec[] = [
    {
      label: 'Identities',
      options: [
        { value: 'box', label: who(git.box) },
        { value: 'operator', label: who(git.operator) },
      ],
    },
  ]
  return (
    <div className="flex flex-col gap-3 border-hairline border-t pt-4">
      <Rows
        rows={[
          {
            k: 'Commit as',
            v: <SiteSelect edit={edit} field="commits.author" label="Commit as" groups={groups} />,
          },
        ]}
      />
      <p className={NOTE}>
        Every commit daedalus makes — an Apply, a secret, an image or engine update — is authored as
        this identity, whoever pressed the button; the person is still named in the commit's body.
        Both identities are the ones nix configures: the box's own, and the operator's git identity
        (<Mono>fleet.operator.gitName</Mono>). The choice is applied like any other change, and that
        Apply already commits as the new identity.
      </p>
    </div>
  )
}

export function SiteSection({
  dir,
  site,
  edit,
  git,
}: {
  dir: SiteDir
  site: SiteState | null
  edit: SiteEdit
  git: GitIdentities
}) {
  const versioned = dir.toplevel !== null && dir.inThisRepo
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
        icon="/icon-git.svg"
        description="What this box is, as data — nix builds the site constants from it. Written by daedalus into the configuration repository, by an Apply."
        rows={[{ k: 'Path', v: <Value v={dir.path} /> }]}
      >
        <SiteFiles dir={dir} site={site} />
        <SourceControl dir={dir} site={site} />
        {versioned && <CommitAs edit={edit} git={git} />}
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
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col p-0">
        {site.files.map((file) => (
          <li
            key={file.name}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-hairline border-t py-2 first:border-t-0 first:pt-0"
          >
            <Mono>{file.name}</Mono>
            <span className="inline-flex items-center gap-2">
              {file.current === false && <Chip tone="warn">differs</Chip>}
              {file.current === true && <Chip tone="ok">current</Chip>}
              <Chip tone={STATUS_TONE[file.status]}>{file.status}</Chip>
            </span>
          </li>
        ))}
      </ul>
      {site.files.some((f) => f.status === 'untracked') && (
        <p className={NOTE_SHOWN}>
          An untracked file is invisible to a rebuild. This should not happen — daedalus stages what
          it writes — so something else put it there, or a <Mono>git reset</Mono> undid the add.
        </p>
      )}
      {site.files.some((f) => f.current === false) && (
        <p className={NOTE_SHOWN}>
          {/* Named, not assumed: two files are compared now, and telling the
              operator site.json differs when it is the README that does sends
              them looking in the wrong file. */}
          <Mono>
            {site.files
              .filter((f) => f.current === false)
              .map((f) => f.name)
              .join(', ')}
          </Mono>{' '}
          is not what this box would write now — the configuration changed since, or it was edited
          by hand. The next Apply writes it again.
        </p>
      )}
      {site.files.find((f) => f.name === 'apps.json')?.status === 'absent' && (
        <p className={NOTE_SHOWN}>
          <Mono>apps.json</Mono> is written only by an Apply, and from here only once nix reads the
          registry from this directory.
        </p>
      )}
    </div>
  )
}
