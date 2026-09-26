import { IdCardIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BoxSettings, ZoneList } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import { controlPlaneLabelError } from '../../lib/site-fields'
import { groupZones } from '../../lib/timezones'
import { saveSiteEditFn } from '../../server/site'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
import { ASIDE, ExtLink, Line, NOTE, Pending, Section, SourceNote, Stack, Value } from './shared'
import { type SelectGroupSpec, SiteSelect, SiteText, SiteUnwritten } from './site-fields'

// Settings › General: what the box calls itself.
//
// Two rows are pickers over a list somebody else owns. The domain is one of the
// Cloudflare zones the API token can see, saved together with that zone's id;
// the timezone is one of the zones this system's tzdata names. The server
// refuses a value outside either list, so the pickers are the convenient path
// and not the only guard.
//
// `zones` is null while Cloudflare is being asked; everything else renders at
// once. The NixOS release is not here on purpose (routes/settings.tsx says why).

export function General({
  settings,
  edit,
  timezones,
  zones,
}: {
  settings: BoxSettings
  edit: SiteEdit
  /** tzdata's zone names; empty when neither zone.tab could be read. */
  timezones: string[]
  zones: ZoneList | null
}) {
  const g = settings.general

  const tzGroups: SelectGroupSpec[] = groupZones(timezones).map((grp) => ({
    label: grp.region,
    options: grp.zones.map((z) => ({ value: z, label: z })),
  }))

  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Identity"
        icon={<IdCardIcon />}
        description="What this box calls itself. Every hostname it publishes is exactly one label under the domain."
        rows={[
          { k: 'Hostname', v: <Value v={g.hostname} /> },
          { k: 'Domain', v: <DomainPicker edit={edit} zones={zones} /> },
          { k: 'This control plane', v: <ControlPlane edit={edit} /> },
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
          The control plane's name is the part in front of the domain. Once a rename is applied, the
          old address keeps working beside the new one until you confirm from the new address, so a
          name that turns out not to work cannot lock you out of this page.
        </p>
        <p className={NOTE}>
          Every container is started with the timezone, so applying a new one restarts all of them.
        </p>
      </Section>

      <SourceNote
        meta={settings.sources.site}
        file="/export/site.json"
        producer="daedalus-export-publish at activation"
      />
    </div>
  )
}

/** The domain, from the zones the API token can see; the zone id rides along. */
function DomainPicker({ edit, zones }: { edit: SiteEdit; zones: ZoneList | null }) {
  const list = zones?.ok === true ? zones.value : []
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
  if (zones === null) {
    return (
      <Stack>
        {picker}
        <Pending />
      </Stack>
    )
  }
  if (!zones.ok) {
    return (
      <Stack>
        {picker}
        <span className={ASIDE}>{zones.reason}</span>
      </Stack>
    )
  }
  return picker
}

/**
 * The control plane's own address. Only the label is a choice: the scheme is
 * always https and the domain is the one picked above, so those are drawn
 * around the box rather than typed into it. A rename keeps the old address
 * answering (core/site keepPreviousAddress), and the old one is retired from
 * the new address — reaching this page there is the proof it works.
 */
function ControlPlane({ edit }: { edit: SiteEdit }) {
  const was = edit.committed?.identity ?? null
  // Where the page was actually reached, which only the browser knows; null on
  // the server render, so nothing here depends on it until hydration.
  const [here, setHere] = useState<string | null>(null)
  useEffect(() => {
    setHere(window.location.hostname)
  }, [])
  const current = was === null ? null : `${was.controlPlane}.${was.baseDomain}`
  const old =
    was === null || was.controlPlanePrevious === null
      ? null
      : `${was.controlPlanePrevious}.${was.baseDomain}`
  return (
    <Stack>
      <SiteText
        edit={edit}
        field="identity.controlPlane"
        label="Control plane name"
        validate={controlPlaneLabelError}
        prefix="https://"
        suffix={`.${edit.desired.identity.baseDomain}`}
        className="w-[11rem]"
      />
      {old !== null &&
        current !== null &&
        (here === current ? (
          <RetireOldAddress old={old} />
        ) : (
          <span className={ASIDE}>
            Moved to <ExtLink href={`https://${current}`}>{current}</ExtLink>. Confirm it from
            there; {old} keeps working until you do.
          </span>
        ))}
    </Stack>
  )
}

function RetireOldAddress({ old }: { old: string }) {
  const { run, busy: saving, error } = useAction()
  return (
    <Stack>
      <Line>
        <span className={ASIDE}>{old} still answers too.</span>
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          onClick={() => {
            run(() => saveSiteEditFn({ data: { 'identity.controlPlanePrevious': null } }))
          }}
        >
          Confirm this address
        </Button>
      </Line>
      {error !== null && <span className={ASIDE}>{error}</span>}
    </Stack>
  )
}
