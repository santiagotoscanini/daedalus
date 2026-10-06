import { Chip } from './viz'

/** A verb's `reboot-required` outcome (lib/reboot-required.ts): the chip, then the host's note. */
export function RebootRequired({ note }: { note: string }) {
  return (
    <div>
      <Chip tone="warn">needs a reboot</Chip>
      <pre className="mt-1.5 mb-0 max-h-40 overflow-auto whitespace-pre-wrap text-[0.75rem] text-muted-foreground">
        {note}
      </pre>
    </div>
  )
}
