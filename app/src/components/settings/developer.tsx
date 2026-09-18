import { FileCodeIcon } from 'lucide-react'
import type { BoxSettings } from '../../core/settings/types'
import type { McpTokenRow } from '../../host/mcp/tokens'
import { Chip } from '../viz'
import { McpTokens } from './mcp-tokens'
import { Section, Value } from './shared'

// How this instance runs, and the credentials that let a machine drive it.
//
// The first two sections are inert by design — they state what the flake
// declared and change nothing. The third is not: MCP tokens are the one thing
// on this tab an operator creates, and they live here rather than under
// Integrations because the caller they authenticate is an agent working on
// this box, not a service the box talks to.

export function Developer({ settings, tokens }: { settings: BoxSettings; tokens: McpTokenRow[] }) {
  const d = settings.developer
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="This instance"
        icon="/icon.svg"
        description="How the control plane itself is run. Declared in the flake, not here."
        rows={[
          {
            k: 'Mode',
            v: d.devServer ? (
              <span className="inline-flex items-center gap-2">
                <Chip tone="info">dev server</Chip>
                <span className="text-[0.78rem] text-(--text-muted)">
                  source.mode = local — Vite over a bind mount; saving a file is the deploy
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Chip tone="ok">image</Chip>
                <span className="text-[0.78rem] text-(--text-muted)">
                  a built image, redeployed on a digest change
                </span>
              </span>
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

      <McpTokens tokens={tokens} />
    </div>
  )
}
