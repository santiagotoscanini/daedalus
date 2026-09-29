import { Chip } from './viz'

/** A verb's `reboot-required` outcome (lib/reboot-required.ts): the chip, then the host's note. */
export function RebootRequired({ note }: { note: string }) {
  return (
    <div>
      <Chip tone="warn">needs a reboot</Chip>
      <pre className="mt-[0.4rem] mb-0 max-h-40 overflow-auto whitespace-pre-wrap text-[0.74rem]">
        {note}
      </pre>
    </div>
  )
}
