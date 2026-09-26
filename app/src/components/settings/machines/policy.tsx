import type { KeyboardEvent, ReactNode } from 'react'

import { cn } from '../../../lib/cn'
import type { MachineShape } from '../../../lib/dashboard/machines'
import { CHOSEN_KINDS, finishesFor, partsOfKind } from '../../../lib/hardware/catalog'
import { slugOf } from '../../../lib/nodes-file'
import {
  DEFAULT_PORT,
  NODE_PROVIDER_KINDS,
  PROVIDER_NAME,
  type ProviderKind,
} from '../../../lib/providers/kinds'
import type { ModelPolicy } from '../../../lib/providers/policy'
import type { NodeRow } from '../../../lib/repo/nodes'
import { useShown } from '../../../lib/shown'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Picker } from '../../ui/picker'
import { Switch } from '../../ui/switch'
import { ProviderModels } from '../provider-models'
import { ASIDE, ERROR_NOTE, FIELD_LABEL, Mono, Rows, Stack } from '../shared'
import { type PolicyEditor, usePolicyEditor } from './use-policy-editor'

// What the box asks of an approved machine, one row per thing it can ask:
// its names, the model servers it offers, keeping it awake, Claude, and the
// parts nothing in it reports. Each row saves on its own
// (./use-policy-editor.ts). The groups below return rows, not cards, so the
// whole policy stays one list.

type Row = { k: string; v: ReactNode }

/** The dropdown value for "no part chosen": Radix refuses an empty string. */
const NONE = '—'

/** Blur a typed field on Enter, which is what saves it. */
const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
}

export function Policy({
  n,
  shape,
  lanDomain,
}: {
  n: NodeRow
  shape: MachineShape | null
  lanDomain: string
}) {
  const ed = usePolicyEditor(n)
  return (
    <div className="flex flex-col gap-3 border-(--border-soft) border-t pt-4">
      <h3 className={cn(FIELD_LABEL, 'm-0')}>Policy</h3>
      <Rows
        rows={[
          ...policyNames(ed, n, lanDomain),
          ...policyProviders(ed, n, lanDomain),
          ...policyAwake(ed),
          ...policyClaude(ed, n),
          ...policyHardware(ed, n, shape),
        ]}
      />
      {ed.error !== null && <p className={ERROR_NOTE}>{ed.error}</p>}
    </div>
  )
}

/** What the pages call the machine, and what the LAN does. */
function policyNames(ed: PolicyEditor, n: NodeRow, lanDomain: string): Row[] {
  return [
    {
      k: 'Display name',
      v: (
        <Stack className="w-full max-w-[22rem]">
          <Input
            value={ed.name}
            placeholder={n.hostname}
            maxLength={40}
            disabled={ed.busy}
            onChange={(e) => ed.setName(e.target.value)}
            onBlur={ed.saveName}
            onKeyDown={blurOnEnter}
          />
          <span className={ASIDE}>What the pages call it; empty means the hostname.</span>
        </Stack>
      ),
    },
    {
      k: 'Name on the network',
      v: (
        <Stack className="w-full max-w-[22rem]">
          <span className="inline-flex items-center gap-2">
            <Input
              value={ed.netName}
              placeholder={slugOf(n.hostname)}
              maxLength={32}
              disabled={ed.busy}
              aria-invalid={ed.netNameBad}
              aria-label="Name on the network"
              onChange={(e) => ed.setNetName(e.target.value)}
              onBlur={ed.saveNetName}
              onKeyDown={blurOnEnter}
            />
            <Mono>
              {ed.netName || slugOf(n.hostname)}.{lanDomain}
            </Mono>
          </span>
          <span className={ASIDE}>
            {ed.netNameBad
              ? 'Letters, digits and hyphens, 1 to 32 long, not starting or ending with a hyphen.'
              : n.namedByHousehold
                ? `The household reservations already name this machine's MAC; pi-hole keeps that name, and this one goes to site/nodes.json only, until the household line is removed.`
                : 'pi-hole gives the lease this name, so the address can be whatever the pool hands out. Empty means the hostname as a label. Nix reads it from site/nodes.json on the next Apply.'}
          </span>
        </Stack>
      ),
    },
  ]
}

/** One row per model server kind the machine could offer the gateway. */
function policyProviders(ed: PolicyEditor, n: NodeRow, lanDomain: string): Row[] {
  return NODE_PROVIDER_KINDS.map((kind) => ({
    k: PROVIDER_NAME[kind],
    v: (
      <ProviderRow
        key={kind}
        kind={kind}
        nodeId={n.id}
        host={`${ed.netName || slugOf(n.hostname)}.${lanDomain}`}
        offered={ed.providerOf(kind).offer}
        port={ed.ports[kind] ?? String(DEFAULT_PORT[kind])}
        busy={ed.busy}
        failed={ed.failed}
        onOffer={(v) => ed.saveProvider(kind, { ...ed.providerOf(kind), offer: v })}
        onPort={(v) => ed.setPort(kind, v)}
        onPortDone={() => ed.savePort(kind)}
        onModel={(id, patch) => ed.changeModel(kind, id, patch)}
      />
    ),
  }))
}

/**
 * One provider a machine could offer: the switch, the port it answers on,
 * and — once offered — what the gateway should call its models. One row per
 * kind in NODE_PROVIDER_KINDS, each owning its own optimistic switch, so a
 * new kind is a name in that list and nothing here.
 */
function ProviderRow({
  kind,
  nodeId,
  host,
  offered,
  port,
  busy,
  failed,
  onOffer,
  onPort,
  onPortDone,
  onModel,
}: {
  kind: ProviderKind
  nodeId: string
  host: string
  offered: boolean
  port: string
  busy: boolean
  failed: boolean
  onOffer: (v: boolean) => void
  onPort: (v: string) => void
  onPortDone: () => void
  onModel: (id: string, patch: ModelPolicy) => void
}) {
  const [offer, showOffer] = useShown(offered, busy, failed)
  const name = PROVIDER_NAME[kind]
  return (
    <Stack className="w-full max-w-[28rem]">
      <span className="inline-flex flex-wrap items-center gap-3">
        <Switch
          checked={offer}
          disabled={busy}
          onCheckedChange={(v) => {
            showOffer(v)
            onOffer(v)
          }}
          aria-label={`Offer ${name} to the gateway`}
        />
        <span className="text-[0.82rem]">{offer ? 'offered to the gateway' : 'not offered'}</span>
        <span className="inline-flex items-center gap-2 text-[0.82rem]">
          port
          <Input
            className="w-[6.5rem]"
            value={port}
            inputMode="numeric"
            disabled={busy}
            aria-label={`${name} port`}
            onChange={(e) => onPort(e.target.value)}
            onBlur={onPortDone}
            onKeyDown={blurOnEnter}
          />
        </span>
      </span>
      <span className={ASIDE}>
        A model server on this machine. Offered, it goes to site/nodes.json and the gateway, gatus
        and the log bridge dial{' '}
        <Mono>
          {host}:{port}
        </Mono>{' '}
        after the next Apply. The agent probes the port and reports whether it answers.
      </span>
      {offer && (
        <ProviderModels nodeId={nodeId} kind={kind} busy={busy} failed={failed} change={onModel} />
      )}
    </Stack>
  )
}

/** Whether the agent holds the machine awake. */
function policyAwake(ed: PolicyEditor): Row[] {
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

/** The Claude Code server the agent's tray runs, and where it runs it. */
function policyClaude(ed: PolicyEditor, n: NodeRow): Row[] {
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
              <Button
                size="sm"
                variant="outline"
                disabled={ed.busy || n.claudeUpdateRequested}
                onClick={ed.updateClaude}
              >
                {n.claudeUpdateRequested ? 'Update queued' : 'Update now'}
              </Button>
            )}
            {ed.claude && (
              <Button
                size="sm"
                variant="outline"
                disabled={ed.busy || n.claudeRestartRequested}
                onClick={ed.restartClaude}
              >
                {n.claudeRestartRequested ? 'Restart queued' : 'Restart now'}
              </Button>
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

/**
 * The parts nothing in the machine reports. A desktop gets a dropdown per
 * kind over the catalog (lib/hardware/catalog.ts) — case, cooler, supply — and
 * the Build tab draws what is chosen. A laptop IS its case, cooler and supply,
 * and reports every part but its colour, so it gets the one thing left to ask:
 * the finish.
 */
function policyHardware(ed: PolicyEditor, n: NodeRow, shape: MachineShape | null): Row[] {
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
