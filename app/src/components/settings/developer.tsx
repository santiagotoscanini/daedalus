import { FileCodeIcon, GitBranchIcon } from 'lucide-react'
import type { BoxSettings } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import type { McpTokenRow } from '../../host/mcp/tokens'
import { Chip } from '../viz'
import { McpTokens } from './mcp-tokens'
import { ASIDE, Line, Mono, NOTE, Section, Value } from './shared'
import { SiteSwitch, SiteUnwritten } from './site-fields'

// How this instance runs, and the credentials that let a machine drive it.
//
// The first two sections are inert by design — they state what the flake
// declared and change nothing. The next two are not: the engine override
// points every Apply at a local clone instead of the pinned engine, and MCP
// tokens are the one thing on this tab an operator creates. Both live here
// rather than under Integrations because their subject is who may drive this
// box and how, not a service the box talks to.

export function Developer({
  settings,
  edit,
  tokens,
}: {
  settings: BoxSettings
  edit: SiteEdit
  tokens: McpTokenRow[]
}) {
  const d = settings.developer
  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="This instance"
        icon="/icon.svg"
        description="How the control plane itself is run. Declared in the flake, not here."
        rows={[
          {
            k: 'Mode',
            v: d.devServer ? (
              <Line>
                <Chip tone="info">dev mode</Chip>
                <span className={ASIDE}>
                  fleet.daedalus.source = "dev" — Vite over the bind-mounted checkout; saving a file
                  is the deploy
                </span>
              </Line>
            ) : (
              <Line>
                <Chip tone="ok">image</Chip>
                <span className={ASIDE}>
                  the built bundle (fleet.daedalus.source: published, or built on this box)
                </span>
              </Line>
            ),
          },
          { k: 'Node', v: <Value v={d.node} /> },
        ]}
      />

      <Section
        title="Paths inside the container"
        icon={<FileCodeIcon />}
        description="Where the host publishes what this app reads, and where the app drops what the host acts on."
        rows={[
          { k: 'Exports', v: <Value v={d.exportDir} /> },
          { k: 'Apply bridge', v: <Value v={d.applyDir} /> },
          { k: 'State root (host)', v: <Value v={d.stateRoot} /> },
        ]}
      />

      <Section
        title="Engine override"
        icon={<GitBranchIcon />}
        description="Build the box from its engine clone instead of the pinned engine, to test nix work before a commit is pinned."
        rows={[
          {
            k: 'Engine clone',
            v: <SiteSwitch edit={edit} field="developer.engineOverride" label="Engine override" />,
          },
        ]}
      >
        <p className={NOTE}>
          The clone is the engine checkout nix names for this box — its <Mono>flake.nix</Mono> is
          what the build reads; this switch cannot point anywhere else. While it is on, every Apply
          builds with <Mono>--override-input daedalus path:&lt;clone&gt;</Mono> and the lock file
          untouched, then activates the result with <Mono>nixos-rebuild test</Mono> rather than{' '}
          <Mono>switch</Mono>: the running system follows the clone as it stands, uncommitted files
          included, and the next boot still comes up on the last switched generation. Image updates
          and the engine update refuse to run until it is cleared — a pin moved under an override
          would name a revision nothing is running.
        </p>
        <p className={NOTE}>
          It is a site.json field like the others: turning it on is a pending edit until Apply, and
          that Apply is already the first one built from the clone. Turning it off and applying is
          what switches the box back onto the pinned engine.
        </p>
      </Section>

      <McpTokens tokens={tokens} />
    </div>
  )
}
