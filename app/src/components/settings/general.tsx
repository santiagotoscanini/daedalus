import type { BoxSettings } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import { baseDomainError } from '../../lib/site-fields'
import { Chip } from '../viz'
import { ExtLink, Mono, Section, SourceNote, Unset, Value } from './shared'
import { SiteText, SiteUnwritten } from './site-fields'

export function General({ settings, edit }: { settings: BoxSettings; edit: SiteEdit }) {
  const g = settings.general
  const rev = g.engine.revision
  const dirty = rev?.endsWith('-dirty') ?? false
  const shortRev = rev === null ? null : rev.replace(/-dirty$/, '').slice(0, 10)

  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Identity"
        description="What this box calls itself. Every hostname it publishes is exactly one label under the domain."
        rows={[
          { k: 'Hostname', v: <Value v={g.hostname} /> },
          {
            k: 'Domain',
            v: (
              <SiteText
                edit={edit}
                field="identity.baseDomain"
                label="Domain"
                validate={baseDomainError}
              />
            ),
          },
          {
            k: 'This control plane',
            v: g.publicUrl === '' ? <Unset /> : <ExtLink href={g.publicUrl} />,
          },
          { k: 'Timezone', v: <Value v={g.timezone} /> },
          {
            k: 'Operator',
            v:
              g.operator.user === '' ? (
                <Unset />
              ) : (
                <span className="inline-flex flex-col items-end gap-[0.1rem]">
                  <Mono>{g.operator.user}</Mono>
                  {g.operator.email !== '' && (
                    <span className="text-[0.78rem] text-(--text-muted)">{g.operator.email}</span>
                  )}
                </span>
              ),
          },
          { k: 'GitHub owner', v: <Value v={g.owner} /> },
        ]}
      >
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          Changing the domain renames every hostname on the box and reissues its wildcard
          certificate — every published URL, tunnel route and login redirect moves with it. It is
          allowed, and it is the most drastic edit on this page.
        </p>
      </Section>

      <Section
        title="Engine"
        description="The NixOS release, and the commit the running generation was built from."
        rows={[
          { k: 'NixOS', v: <Value v={g.engine.nixosVersion} /> },
          {
            k: 'Built from',
            v:
              shortRev === null ? (
                <Unset label="no revision — built outside a git checkout" />
              ) : (
                <span className="inline-flex items-center gap-2">
                  {dirty && <Chip tone="warn">dirty tree</Chip>}
                  <Mono>{shortRev}</Mono>
                </span>
              ),
          },
        ]}
      >
        {dirty && (
          <p className="m-0 text-[0.78rem] text-(--text-muted)">
            The generation was built from a checkout with uncommitted changes, so no commit
            reproduces it exactly. Commit, then rebuild.
          </p>
        )}
      </Section>

      <SourceNote
        meta={settings.sources.site}
        file="/export/site.json"
        producer="daedalus-export-publish at activation"
      />
    </div>
  )
}
