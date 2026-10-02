import type { VercelStatus } from '../../core/settings/types'
import { vercelTokenShapeError } from '../../lib/vercel-token'
import { replaceVercelTokenFn } from '../../server/settings'
import { PLATFORM_ICONS } from '../apps/app-card'
import { Chip } from '../viz'
import { Token, TokenForm } from './cloudflare'
import { Pending, Section } from './shared'

// The Vercel half of Settings › Integrations: the token the off-box list
// reads Vercel with (core/offbox/vercel.ts), whether it still works, which
// scopes it reaches, and the form that sets or replaces it.

export function Vercel({
  configured,
  status,
}: {
  configured: boolean
  status: VercelStatus | null
}) {
  return (
    <Section
      title="Vercel"
      icon={PLATFORM_ICONS.Vercel}
      description="The projects hosted on Vercel, read for the Apps page: their domains, deployments, traffic and firewall."
      rows={[
        {
          k: 'API token',
          v: <Token configured={configured} check={status === null ? undefined : status.token} />,
        },
        {
          k: 'Reads',
          v: !configured ? (
            <Chip tone="muted">nothing yet</Chip>
          ) : status === null ? (
            <Pending />
          ) : status.scopes.length === 0 ? (
            <Chip tone="muted">no scope</Chip>
          ) : (
            <span className="inline-flex flex-wrap gap-1.5">
              {status.scopes.map((s) => (
                <Chip key={s} tone="muted">
                  {s}
                </Chip>
              ))}
            </span>
          ),
        },
      ]}
    >
      <TokenForm
        opener={configured ? 'Replace token…' : 'Add token…'}
        label="Vercel token"
        shapeError={vercelTokenShapeError}
        apply={(token) => replaceVercelTokenFn({ data: { token } })}
        notice={(v) =>
          `Checked and applying: it reads as ${v.user}. The control plane restarts with it.`
        }
      >
        Create one at vercel.com › Account Settings › Tokens, scoped to the team that holds the
        projects, with an expiry. Vercel has no read-only token; the box only ever reads with it. It
        is checked against Vercel first, then encrypted here, saved to site/vault/ and applied.
      </TokenForm>
    </Section>
  )
}
