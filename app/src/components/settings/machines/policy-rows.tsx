// The policy's later sections, a row list each: awake, alert, Claude, santree, hardware.

import type { KeyboardEvent } from 'react'
import type { MachineShape } from '../../../lib/dashboard/machines'
import { CHOSEN_KINDS, finishesFor, partsOfKind } from '../../../lib/hardware/catalog'
import type { NodeRow } from '../../../lib/repo/nodes'
import { NodeCommandButton } from '../../node-command'
import { Input } from '../../ui/input'
import { Picker } from '../../ui/picker'
import { Switch } from '../../ui/switch'
import { ASIDE, Mono, Stack } from '../shared'
import type { Row } from './policy'
import { SantreeGrant } from './santree-grant'
import type { PolicyEditor } from './use-policy-editor'

/** Whether the agent holds the machine awake. */
export function policyAwake(ed: PolicyEditor): Row[] {
  return [
    {
      k: 'Keep awake',
      v: (
        <Stack>
          <span className="inline-flex items-center gap-3">
            <Switch
              checked={ed.awake}
              disabled={ed.busy}
              onCheckedChange={ed.setAwake}
              aria-label="Keep awake"
            />
            <span className="text-[0.82rem]">{ed.awake ? 'held awake' : 'may sleep'}</span>
          </span>
          <span className={ASIDE}>
            On, the agent holds a power request for as long as it runs and turns the plan's sleep
            timers off. Off releases the request; the plan is left as it is.
          </span>
        </Stack>
      ),
    },
  ]
}

/** Whether Machine Link Down mails when the machine's link is down. */
export function policyAlert(ed: PolicyEditor): Row[] {
  return [
    {
      k: 'Alert when disconnected',
      v: (
        <Stack>
          <span className="inline-flex items-center gap-3">
            <Switch
              checked={ed.alertLink}
              disabled={ed.busy}
              onCheckedChange={ed.setAlertLink}
              aria-label="Alert when disconnected"
            />
            <span className="text-[0.82rem]">{ed.alertLink ? 'alerts' : 'quiet'}</span>
          </span>
          <span className={ASIDE}>
            On, Grafana's Machine Link Down fires after the link has been down for 5 minutes. Turn
            it off for a laptop that sleeps or leaves the house; the pages still show it offline.
          </span>
        </Stack>
      ),
    },
  ]
}

/** The Claude Code server the agent's tray runs, and where it runs it. */
export function policyClaude(ed: PolicyEditor, n: NodeRow): Row[] {
  return [
    {
      k: 'Claude remote control',
      v: (
        <Stack>
          <span className="inline-flex flex-wrap items-center gap-3">
            <Switch
              checked={ed.claude}
              disabled={ed.busy}
              onCheckedChange={ed.setClaude}
              aria-label="Claude remote control"
            />
            <span className="text-[0.82rem]">{ed.claude ? 'runs' : 'off'}</span>
            {/* Update first, then restart: that is the order they are
                used in, and the cheap one should not be reached past
                the expensive one. */}
            {ed.claude && (
              <NodeCommandButton id={n.id} command="claude_update" label="Update now" />
            )}
            {ed.claude && (
              <NodeCommandButton id={n.id} command="claude_restart" label="Restart now" />
            )}
          </span>
          <span className={ASIDE}>
            The agent's tray runs <Mono>claude remote-control</Mono> in the user's session, with
            that user's Claude login, the way this box runs its own.
          </span>
        </Stack>
      ),
    },
    {
      k: 'Claude working directory',
      v: (
        <Stack className="w-full max-w-[28rem]">
          <Input
            value={ed.workdir}
            placeholder="the most recently used trusted project"
            maxLength={260}
            disabled={ed.busy}
            onChange={(e) => ed.setWorkdir(e.target.value)}
            onBlur={ed.saveWorkdir}
            onKeyDown={blurOnEnter}
          />
          <span className={ASIDE}>
            Where the server runs, and so where a session opened from claude.ai lands. Claude
            refuses the home directory (home-directory trust is never saved), so this must be a
            project directory <Mono>claude</Mono> has been run in once and trusted. Empty lets the
            tray pick the trusted project used most recently.
          </span>
        </Stack>
      ),
    },
  ]
}

/** Whether santree on the machine may open the box's projects, through the session host. */
export function policySantree(
  ed: PolicyEditor,
  n: NodeRow,
  os: string,
  agentVersion: string,
): Row[] {
  return [
    {
      k: 'santree',
      v: (
        <Stack className="w-full max-w-[34rem]">
          <span className="inline-flex items-center gap-3">
            <Switch
              checked={ed.santree || ed.askingSantree}
              disabled={ed.busy}
              onCheckedChange={(v) =>
                v || !ed.askingSantree ? ed.setSantree(v) : ed.closeSantree()
              }
              aria-label="santree"
            />
            <span className="text-[0.82rem]">
              {ed.santree ? "opens the box's projects" : ed.askingSantree ? 'confirm below' : 'off'}
            </span>
          </span>
          <span className={ASIDE}>
            On, santree on this machine can open terminals and run commands in the box's projects,
            through its agent: a shell on the box. Turning it on asks you to confirm, with the
            machine's key shown to compare. Off closes its connections and ends its terminals.
          </span>
          {ed.askingSantree && !ed.santree && (
            <SantreeGrant n={n} os={os} agentVersion={agentVersion} onClose={ed.closeSantree} />
          )}
        </Stack>
      ),
    },
  ]
}

/**
 * The parts nothing in the machine reports. A desktop gets a dropdown per
 * kind over the catalog (lib/hardware/catalog.ts) — case, cooler, supply — and
 * the Build tab draws what is chosen. A laptop IS its case, cooler and supply,
 * and reports every part but its colour, so it gets the one thing left to ask:
 * the finish.
 */
export function policyHardware(ed: PolicyEditor, n: NodeRow, shape: MachineShape | null): Row[] {
  // What the machine is decides what is worth asking. A Mac is a laptop
  // whatever the chassis field says; the model names its finishes.
  const laptop = shape?.form === 'laptop' || n.os === 'macos'
  const finishes = finishesFor(shape?.model)
  if (laptop) {
    if (finishes.length === 0) return []
    return [
      {
        k: 'Finish',
        v: (
          <Stack className="w-full max-w-[28rem]">
            <Picker
              value={n.policy.hardware?.finish ?? NONE}
              busy={ed.busy}
              failed={ed.failed}
              disabled={ed.busy}
              aria-label="finish"
              options={[
                { value: NONE, label: 'not set' },
                ...finishes.map((f) => ({ value: f.id, label: f.name })),
              ]}
              onChange={(v) => {
                ed.saveHardware('finish', v === NONE ? undefined : v)
              }}
            />
            <span className={ASIDE}>
              The machine reports its model and everything in it; the colour is the one thing it
              does not say. The pages draw the photo that matches.
            </span>
          </Stack>
        ),
      },
    ]
  }
  return CHOSEN_KINDS.map((kind) => ({
    k: kind === 'case' ? 'Case' : kind === 'cooler' ? 'CPU cooler' : 'Power supply',
    v: (
      <Stack className="w-full max-w-[28rem]">
        <Picker
          value={n.policy.hardware?.[kind] ?? NONE}
          busy={ed.busy}
          failed={ed.failed}
          disabled={ed.busy}
          aria-label={kind}
          options={[
            { value: NONE, label: 'not set' },
            ...partsOfKind(kind).map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(v) => {
            ed.saveHardware(kind, v === NONE ? undefined : v)
          }}
        />
        {kind === 'psu' && (
          <span className={ASIDE}>
            Nothing in a PC reports its case, cooler or supply, so these are chosen rather than
            read; the Build tab draws what is chosen, with the catalog's photo and specification. A
            part that is not on the list is a line in the catalog.
          </span>
        )}
      </Stack>
    ),
  }))
}

/** Blur a typed field on Enter, which is what saves it. */
export const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
}

/** The dropdown value for "no part chosen": Radix refuses an empty string. */
export const NONE = '—'
