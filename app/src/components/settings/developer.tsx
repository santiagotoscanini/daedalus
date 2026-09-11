import { FileCodeIcon } from 'lucide-react'
import type { BoxSettings } from '../../core/settings/types'
import { Chip } from '../viz'
import { Section, Value } from './shared'

// Inert by design. This is where developer settings will live — the
// image-vs-local source switch, verbose logging — once the module system
// gives them something to act on. Today it states how this instance runs and
// changes nothing.

export function Developer({ settings }: { settings: BoxSettings }) {
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

      <p className="m-0 text-[0.74rem] text-(--dim)">
        Nothing on this tab is editable yet. Developer settings arrive with the module system.
      </p>
    </div>
  )
}
