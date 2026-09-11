import type { BoxSettings, GeneralLive, NixosRelease, ZoneList } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import type { NixosFacts } from '../../lib/contract/domains/site'
import { num, since } from '../../lib/format'
import { builtOn, type Support } from '../../lib/nixos'
import { groupZones } from '../../lib/timezones'
import { ReleaseNotes, UpgradeChain } from '../release-notes'
import { Chip } from '../viz'
import { ExtLink, Mono, Pending, Section, SourceNote, Unset, Value } from './shared'
import { type SelectGroupSpec, SiteSelect, SiteUnwritten } from './site-fields'

// Settings › General: what the box calls itself, and what it runs.
//
// Two rows are pickers over a list somebody else owns. The domain is one of the
// Cloudflare zones the API token can see, saved together with that zone's id;
// the timezone is one of the zones this system's tzdata names. The server
// refuses a value outside either list, so the pickers are the convenient path
// and not the only guard.
//
// `live` is null while Cloudflare, endoflife.date and GitHub are being asked.
// Everything that does not depend on them renders at once.

const ASIDE = 'text-[0.72rem] text-(--dim)'
const STACK = 'inline-flex max-w-full flex-col items-end gap-[0.1rem] text-right'
const LINE = 'inline-flex flex-wrap items-center justify-end gap-2'
const NOTE = 'm-0 text-[0.78rem] text-(--text-muted)'

export function General({
  settings,
  edit,
  timezones,
  live,
}: {
  settings: BoxSettings
  edit: SiteEdit
  /** tzdata's zone names; empty when neither zone.tab could be read. */
  timezones: string[]
  live: GeneralLive | null
}) {
  const g = settings.general
  const rev = g.engine.revision
  const dirty = rev?.endsWith('-dirty') ?? false
  const shortRev = rev === null ? null : rev.replace(/-dirty$/, '').slice(0, 10)
  const nixos = g.engine.nixos
  const release = live?.nixos ?? null

  const tzGroups: SelectGroupSpec[] = groupZones(timezones).map((grp) => ({
    label: grp.region,
    options: grp.zones.map((z) => ({ value: z, label: z })),
  }))

  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Identity"
        description="What this box calls itself. Every hostname it publishes is exactly one label under the domain."
        rows={[
          { k: 'Hostname', v: <Value v={g.hostname} /> },
          { k: 'Domain', v: <DomainPicker edit={edit} zones={live?.zones} /> },
          {
            k: 'This control plane',
            v: g.publicUrl === '' ? <Unset /> : <ExtLink href={g.publicUrl} />,
          },
          {
            k: 'Timezone',
            v: (
              <SiteSelect
                edit={edit}
                field="identity.timezone"
                label="Timezone"
                groups={tzGroups}
                disabled={timezones.length === 0}
              />
            ),
          },
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
        ]}
      >
        <p className={NOTE}>
          The domains are the Cloudflare zones the API token can see, and a zone's id is saved with
          it. A zone appears here once that token covers it. Changing the domain renames every
          hostname on the box and reissues its wildcard certificate — every published URL, tunnel
          route and login redirect moves with it. It is allowed, and it is the most drastic edit on
          this page.
        </p>
        <p className={NOTE}>
          Every container is started with the timezone, so applying a new one restarts all of them.
        </p>
      </Section>

      <Section
        title="Engine"
        icon="/icon-nixos.webp"
        description="The NixOS release this generation was built with, where it stands on its support window, and the commit the configuration was built from."
        rows={[
          ...(nixos === null
            ? [{ k: 'NixOS', v: <Value v={g.engine.nixosVersion} /> }]
            : [
                { k: 'NixOS', v: <ReleaseCell facts={nixos} release={release} live={live} /> },
                { k: 'nixpkgs', v: <Nixpkgs facts={nixos} /> },
                { k: 'Channel', v: <Channel release={release} /> },
                { k: 'Latest release', v: <Latest facts={nixos} release={release} /> },
                { k: 'Kernel', v: <Value v={nixos.kernel} /> },
                { k: 'State version', v: <Value v={nixos.stateVersion} /> },
              ]),
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
        {nixos === null && (
          <p className={NOTE}>
            The export names the version only. The release, its channel and its kernel arrive with
            the next rebuild.
          </p>
        )}
        {nixos !== null &&
          release?.support?.state === 'ended' &&
          release.latest !== null &&
          release.latest.cycle !== nixos.release && (
            <p className={NOTE}>
              {nixos.release} stopped receiving fixes on {release.support.eol}. Moving to{' '}
              {release.latest.cycle} is a change to the flake's nixpkgs input and a rebuild; its
              backward incompatibilities, below, are what to read first.
            </p>
          )}
        {dirty && (
          <p className={NOTE}>
            The generation was built from a checkout with uncommitted changes, so no commit
            reproduces it exactly. Commit, then rebuild.
          </p>
        )}
      </Section>

      {nixos !== null && <Notes facts={nixos} release={release} />}

      <SourceNote
        meta={settings.sources.site}
        file="/export/site.json"
        producer="daedalus-export-publish at activation"
      />
    </div>
  )
}

/** The domain, from the zones the API token can see; the zone id rides along. */
function DomainPicker({ edit, zones }: { edit: SiteEdit; zones: ZoneList | undefined }) {
  const list = zones?.ok === true ? zones.zones : []
  const groups: SelectGroupSpec[] =
    list.length === 0
      ? []
      : [
          {
            label: 'Cloudflare zones',
            options: list.map((z) => ({ value: z.name, label: z.name })),
          },
        ]
  const picker = (
    <SiteSelect
      edit={edit}
      field="identity.baseDomain"
      label="Domain"
      groups={groups}
      disabled={zones?.ok !== true}
      patchFor={(name) => ({
        'identity.baseDomain': name,
        'cloudflare.zoneId': list.find((z) => z.name === name)?.id,
      })}
    />
  )
  if (zones === undefined) {
    return (
      <span className={STACK}>
        {picker}
        <Pending />
      </span>
    )
  }
  if (!zones.ok) {
    return (
      <span className={STACK}>
        {picker}
        <span className={ASIDE}>{zones.reason}</span>
      </span>
    )
  }
  return picker
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

function ReleaseCell({
  facts,
  release,
  live,
}: {
  facts: NixosFacts
  release: NixosRelease | null
  live: GeneralLive | null
}) {
  return (
    <span className={STACK}>
      <span className={LINE}>
        {live === null ? <Pending /> : <SupportChip support={release?.support ?? null} />}
        <Mono>{facts.release}</Mono>
        {facts.codeName !== '' && (
          <span className="text-[0.82rem] text-(--text-muted)">{facts.codeName}</span>
        )}
      </span>
      <span className={ASIDE}>{facts.version}</span>
    </span>
  )
}

function Nixpkgs({ facts }: { facts: NixosFacts }) {
  if (facts.revision === null) return <Unset label="no revision; nixpkgs was not a git input" />
  const day = builtOn(facts.version)
  return (
    <span className={STACK}>
      <ExtLink href={`https://github.com/NixOS/nixpkgs/commit/${facts.revision}`}>
        {facts.revision.slice(0, 10)}
      </ExtLink>
      {day !== null && <span className={ASIDE}>committed {day}</span>}
    </span>
  )
}

function Channel({ release }: { release: NixosRelease | null }) {
  if (release === null) return <Pending />
  const c = release.channel
  const ended = release.support?.state === 'ended'
  return (
    <span className={STACK}>
      <span className={LINE}>
        {c.newer === null ? (
          <Chip tone="muted">not compared</Chip>
        ) : c.newer === 0 ? (
          <Chip tone={ended ? 'muted' : 'ok'}>no newer commits</Chip>
        ) : (
          <Chip tone="warn">
            {num(c.newer)} newer commit{c.newer === 1 ? '' : 's'}
          </Chip>
        )}
        <Mono>{c.branch}</Mono>
      </span>
      {c.head !== null && <span className={ASIDE}>last commit {c.head.date}</span>}
    </span>
  )
}

function Latest({ facts, release }: { facts: NixosFacts; release: NixosRelease | null }) {
  if (release === null) return <Pending />
  const l = release.latest
  if (l === null) return <Unset label="endoflife.date did not answer" />
  if (l.cycle === facts.release) return <Chip tone="ok">this release</Chip>
  return (
    <span className={STACK}>
      <span className={LINE}>
        <Mono>{l.cycle}</Mono>
        {l.codename !== '' && (
          <span className="text-[0.82rem] text-(--text-muted)">{l.codename}</span>
        )}
      </span>
      <span className={ASIDE}>
        released {l.releaseDate}
        {release.latestSupport !== null && ` · supported until ${release.latestSupport.eol}`}
      </span>
    </span>
  )
}

function Notes({ facts, release }: { facts: NixosFacts; release: NixosRelease | null }) {
  const next =
    release?.latest !== null &&
    release?.latest !== undefined &&
    release.latest.cycle !== facts.release
      ? release.latest.cycle
      : null
  return (
    <Section
      title="Release notes"
      description={
        next === null
          ? `What ${facts.release} shipped.`
          : `What ${facts.release} shipped, and what ${next} would bring.`
      }
    >
      {release === null ? (
        <Pending className="block h-24 w-full" />
      ) : release.notes.length === 0 ? (
        <Unset label={release.note ?? 'no release notes could be read'} />
      ) : (
        <div>
          {next !== null && <UpgradeChain behind={[next]} />}
          <ReleaseNotes releases={release.notes} running={facts.release} />
        </div>
      )}
      {release !== null && (
        <p className="m-0 text-[0.74rem] text-(--dim)">
          {release.note !== null && `${release.note}. `}
          From the NixOS manual's release notes in nixpkgs, first paragraphs only; open one for the
          full list. Asked {since((Date.now() - Date.parse(release.checkedAt)) / 1000)}, at most
          hourly.
        </p>
      )}
    </Section>
  )
}
