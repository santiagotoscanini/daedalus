import type { ReactNode } from 'react'

import { cn } from '../../../lib/cn'
import type { MachineShape } from '../../../lib/dashboard/machines'
import { useHydrated } from '../../../lib/hydrated'
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
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { ProviderModels } from '../provider-models'
import { ASIDE, ERROR_NOTE, FIELD_LABEL, Mono, Rows, Stack } from '../shared'
import {
  blurOnEnter,
  policyAwake,
  policyClaude,
  policyHardware,
  policySantree,
} from './policy-rows'
import { type PolicyEditor, usePolicyEditor } from './use-policy-editor'

// What the box asks of an approved machine, one row per thing it can ask:
// its names, the model servers it offers, keeping it awake, Claude, santree,
// and the parts nothing in it reports. Each row saves on its own
// (./use-policy-editor.ts). The groups below return rows, not cards, so the
// whole policy stays one list.

export type Row = { k: string; v: ReactNode }

export function Policy({
  n,
  shape,
  lanDomain,
  os,
  agentVersion,
  askSantree = false,
}: {
  n: NodeRow
  shape: MachineShape | null
  lanDomain: string
  /** What the santree confirmation shows of the machine. */
  os: string
  agentVersion: string
  /** Opened from the machine's own "santree on the box" (the page's link). */
  askSantree?: boolean
}) {
  const ed = usePolicyEditor(n, { askSantree })
  // The time is the browser's clock and zone, which the server render does not
  // share: it joins the line once hydration is done (lib/hydrated.ts).
  const hydrated = useHydrated()
  return (
    <div className="flex flex-col gap-3 border-subtle border-t pt-4">
      <h3 className={cn(FIELD_LABEL, 'm-0')}>Policy</h3>
      <Rows
        rows={[
          ...policyNames(ed, n, lanDomain),
          ...policyProviders(ed, n, lanDomain),
          ...policyAwake(ed),
          ...policyClaude(ed, n),
          ...policySantree(ed, n, os, agentVersion),
          ...policyHardware(ed, n, shape),
        ]}
      />
      {ed.error !== null && <p className={ERROR_NOTE}>{ed.error}</p>}
      {n.policyChangedBy !== null && <p className={ASIDE}>Last changed {changedBy(n, hydrated)}</p>}
    </div>
  )
}

/**
 * "by this Mac · 12:03", "by santiago · 12:03": who changed the policy last —
 * the machine itself from its menu bar or santree, or a person here.
 * `withTime` false leaves the time out: the server and the hydration pass
 * render without it, since only the browser knows its own timezone.
 */
function changedBy(
  n: Pick<NodeRow, 'id' | 'os' | 'policyChangedBy' | 'policyChangedAt'>,
  withTime = true,
): string {
  const who =
    n.policyChangedBy === `node:${n.id}`
      ? n.os === 'macos'
        ? 'this Mac'
        : 'this machine'
      : (n.policyChangedBy ?? 'someone')
  const at = !withTime || n.policyChangedAt === null ? '' : ` · ${clockOf(n.policyChangedAt)}`
  return `by ${who}${at}`
}

/** `HH:MM`, local, of an ISO stamp; the date too when it is not today. */
function clockOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`
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
