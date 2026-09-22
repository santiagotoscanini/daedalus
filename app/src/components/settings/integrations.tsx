import { ServerIcon } from 'lucide-react'

import type { BoxSettings, IntegrationStatus } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import { since, when } from '../../lib/format'
import { mailAddressError } from '../../lib/site-fields'
import { Identified, ReplaceToken, Token } from './cloudflare'
import { Github, GithubApp, type GithubAppProps } from './github-app'
import { ExtLink, Mono, Pending, Section, Stack, Unset, Value } from './shared'
import { SiteText, SiteUnwritten } from './site-fields'

// The Integrations tab's frame: four sections of facts, in the order a
// request travels — the edge, the source of the code, the mail that reports on
// it, and the two services on this box worth a link.
//
// Two kinds of fact side by side: what is CONFIGURED (ids and whether a
// credential is present — known at once, from env) and whether it WORKS
// (asked of the service — deferred, cached five minutes). `status` is null
// while the second kind is in flight, and each live cell draws a skeleton
// rather than the section waiting as a whole.
//
// The two mail addresses are the only editable rows: nix sources them from
// site.json. The ids and tokens are not — the ids are read from the running
// configuration, the tokens live in the secret tree. The GitHub App is created
// from here, but what it writes goes through its own Apply.
//
// The machinery behind the two credentials lives beside this file, one module
// per thing that can be changed: ./cloudflare (the token), ./github-app (the
// App, from creation to installation) and ./github-paste-key (its recovery
// form). What stays here is the layout.

export type { GithubAppProps }

export function Integrations({
  settings,
  status,
  edit,
  github,
}: {
  settings: BoxSettings['integrations']
  status: IntegrationStatus | null
  edit: SiteEdit
  github: GithubAppProps
}) {
  const cf = settings.cloudflare
  const gh = settings.github
  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Cloudflare"
        icon="/icon-cloudflare.svg"
        description="The zone every hostname lives in, the tunnel public traffic arrives through, and the one token that drives both."
        rows={[
          { k: 'Account', v: <Value v={cf.accountId} /> },
          {
            k: 'Zone',
            v: (
              <Identified
                id={cf.zoneId}
                live={status === null ? undefined : status.cloudflare.zone}
                needs="Zone › Zone › Read"
              />
            ),
          },
          {
            k: 'Tunnel',
            v: (
              <Identified
                id={cf.tunnelId}
                live={status === null ? undefined : status.cloudflare.tunnel}
                needs="Account › Cloudflare One Connector: cloudflared › Read"
              />
            ),
          },
          {
            k: 'API token',
            v: (
              <Token
                configured={cf.tokenConfigured}
                check={status === null ? undefined : status.cloudflare.token}
              />
            ),
          },
        ]}
      >
        <ReplaceToken />
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          One token does all of it: Zone › Zone › Read and Zone › DNS › Edit for the certificate,
          the tunnel's records, the dynamic address and the domain picker, and Account › Cloudflare
          One Connector: cloudflared › Read for the tunnel. The zone and tunnel names are read with
          it, which is what proves the scope rather than just the token.
        </p>
      </Section>

      <Section
        title="GitHub"
        icon="/icon-github.svg"
        mono
        description="Where the app repos live, and how the box talks to GitHub: the repo-token override below, and its own App once one is created and installed."
        rows={[
          {
            k: 'Owner',
            v:
              gh.owner === '' ? (
                <Unset />
              ) : (
                <ExtLink href={`https://github.com/${gh.owner}`}>{gh.owner}</ExtLink>
              ),
          },
          {
            k: 'Repo token',
            v: (
              <Github
                // A null reason is the check saying there was no token to ask
                // about — everything else is a token that exists and did not work.
                configured={
                  status === null ||
                  status.github.repoToken.ok ||
                  status.github.repoToken.reason !== null
                }
                check={status === null ? undefined : status.github.repoToken}
              />
            ),
          },
        ]}
      >
        <GithubApp {...github} />
      </Section>

      <Section
        title="Mail relay"
        icon="/icon-gmail.svg"
        description="Every alert and failure mail on the box leaves through one Gmail relay."
        rows={[
          {
            k: 'Sender',
            v: (
              <SiteText
                edit={edit}
                field="mail.sender"
                label="Sender"
                validate={mailAddressError}
              />
            ),
          },
          {
            k: 'Alerts to',
            v: (
              <SiteText
                edit={edit}
                field="mail.alertTo"
                label="Alerts to"
                validate={mailAddressError}
              />
            ),
          },
          {
            k: 'Last send',
            v:
              status === null ? (
                <Pending />
              ) : status.mail.lastSentAt === null ? (
                <Unset label="nothing in the last 30 days" />
              ) : (
                <Stack>
                  <Mono>{when(status.mail.lastSentAt)}</Mono>
                  {status.mail.lastRecipient !== null && (
                    <span className="text-[0.78rem] text-(--text-muted)">
                      to {status.mail.lastRecipient}
                    </span>
                  )}
                </Stack>
              ),
          },
        ]}
      />

      <Section
        title="On this box"
        icon={<ServerIcon />}
        rows={[
          {
            k: 'Image registry',
            v:
              settings.registryUrl === '' ? (
                <Unset />
              ) : (
                <AppLink icon="/icon-zot.png" href={settings.registryUrl} />
              ),
          },
          {
            k: 'Grafana',
            v:
              settings.grafanaUrl === '' ? (
                <Unset />
              ) : (
                <AppLink icon="/icon-grafana.svg" href={settings.grafanaUrl} />
              ),
          },
        ]}
      />

      {status !== null && (
        <p className="m-0 text-[0.74rem] text-(--dim)">
          Checked {since((Date.now() - Date.parse(status.checkedAt)) / 1000)}; each service is asked
          at most every five minutes.
        </p>
      )}
    </div>
  )
}

/** A link to one of the box's own services, beside that service's mark. */
function AppLink({ icon, href }: { icon: string; href: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <img src={icon} alt="" width={16} height={16} className="size-4 flex-none object-contain" />
      <ExtLink href={href} />
    </span>
  )
}
