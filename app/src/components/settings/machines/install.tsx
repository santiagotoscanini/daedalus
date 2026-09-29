import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { installLines } from '../../../lib/agent/install'
import { cn } from '../../../lib/cn'
import type { ControllerView } from '../../../lib/dashboard/machines'
import { Button } from '../../ui/button'
import { MONO, NOTE } from '../shared'

// How a machine joins: one line per system, carrying this box's controller
// address and the fingerprint of its key, so the machine trusts that key
// from its first connection instead of whatever answers first. The line runs
// as root, so it is always shown, not only copied.

function CopyLine({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const line = useRef<HTMLParagraphElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an insecure origin, a refused permission): select the
      // line so a keyboard copy takes it.
      const el = line.current
      const selection = window.getSelection()
      if (el !== null && selection !== null) {
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }
  return (
    <div className="flex items-start gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => void copy()}
        aria-label={`Copy the ${label} install command`}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <p ref={line} className={cn(MONO, 'm-0 select-all pt-1')}>
        {command}
      </p>
    </div>
  )
}

export function Install({ controller }: { controller: ControllerView }) {
  const pinned =
    controller.reachable && controller.address !== null
      ? { address: controller.address, fingerprint: controller.fingerprint }
      : null
  return (
    <div className="flex flex-col gap-3">
      {installLines(pinned).map((l) => (
        <div key={l.os} className="flex flex-col gap-1">
          <p className={NOTE}>
            {l.label}, from {l.where}:
          </p>
          <CopyLine command={l.command} label={l.label} />
        </div>
      ))}
      <p className={NOTE}>
        {pinned === null
          ? `The controller did not say where it listens${controller.reachable ? '' : ` (${controller.error})`}, so these lines name no controller and pin no key: a machine installed from them connects nowhere until it runs the line again with the pin, once the controller answers here.`
          : 'The line names the controller and pins its key: the machine connects to it and to nothing else. It then appears above as waiting, with both fingerprints, until you approve it. Re-running the line on a machine that is already here replaces the binaries, keeps its key, and pins the controller.'}
      </p>
    </div>
  )
}
