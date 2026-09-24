import { useRouter } from '@tanstack/react-router'
import { MonitorSmartphoneIcon } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'

import type { NodePolicy } from '../../host/schema'
import { agentHasClaude } from '../../lib/agent/status'
import { cn } from '../../lib/cn'
import type { Machine, MachineShape, MachinesData } from '../../lib/dashboard/machines'
import { bytes, duration, since } from '../../lib/format'
import { CHOSEN_KINDS, finishesFor, partsOfKind } from '../../lib/hardware/catalog'
import { NODE_NAME_RE, slugOf } from '../../lib/nodes-file'
import {
  DEFAULT_PORT,
  NODE_PROVIDER_KINDS,
  PROVIDER_NAME,
  type ProviderKind,
} from '../../lib/providers/kinds'
import type { ModelPolicy } from '../../lib/providers/policy'
import { errorText } from '../../lib/redact'
import type { NodeRow } from '../../lib/repo/nodes'
import { useShown } from '../../lib/shown'
import type { Tone } from '../../lib/tone'
import {
  approveNodeFn,
  forgetNodeFn,
  requestClaudeRestartFn,
  requestClaudeUpdateFn,
  requestUpdateCheckFn,
  revokeNodeFn,
  saveNodePolicyFn,
} from '../../server/nodes'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Picker } from '../ui/picker'
import { Switch } from '../ui/switch'
import { Chip } from '../viz'
import { BoxProvider, GatewaySync, ProviderModels } from './provider-models'
import {
  ASIDE,
  ERROR_NOTE,
  FIELD_LABEL,
  Line,
  MONO,
  Mono,
  NOTE,
  Rows,
  Section,
  Stack,
} from './shared'

// Settings › Machines — the other computers on this network that run the
// agent: what each one is, whether the box trusts it, and what the box asks
// of it. One card per machine, and the whole story on it, because the
// decision about a machine and the policy sent to it were two tabs on two
// pages, and reading either meant visiting the other.
//
// Two kinds of machine, told apart by the chip. One that said hello has a
// node row and a state — pending until approved, approved, or revoked — and
// the buttons act on that row. One that was merely found (its status page
// answers, but no hello reached the box) has no identity the box can act on;
// the card says why and what to do.
//
// The second kind of setting on this page: Postgres, not site/. A policy
// travels to its machine on the answer to the agent's next hello, so a
// switch here reaches the machine within a minute and nothing rebuilds —
// which is why each row saves on click, like Appearance, with no Apply bar.
// The policy rows appear only once a machine is approved: the box does not
// send a policy to a machine it has not approved, and a switch that appears
// to do nothing is worse than none.
//
// The install line is on the page rather than in a doc: a machine that is
// not here yet is one PowerShell line away, and this is where the person
// looking for it is standing.

const INSTALL_WINDOWS = 'irm https://daedalus.toscanini.me/install.ps1 | iex'
const INSTALL_MACOS = 'curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh'

/** The agent's own defaults, which a key the policy leaves unset falls back to. */
const DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

/** The OS's mark, by the family the agent reports. */
function osMark(os: string): { src: string; invert: boolean } | null {
  switch (os) {
    case 'windows':
      return { src: '/icon-windows.svg', invert: false }
    case 'macos':
      return { src: '/icon-apple.svg', invert: true }
    case 'linux':
      return { src: '/icon-linux.svg', invert: true }
    default:
      return null
  }
}

type Verdict = { chip: string; tone: Tone }

function verdict(m: Machine): Verdict {
  const s = m.status
  switch (m.node?.state) {
    case 'pending':
      return { chip: 'wants to join', tone: 'warn' }
    case 'revoked':
      return { chip: 'revoked', tone: 'bad' }
    case 'approved':
      if (s === null) return { chip: 'not answering', tone: 'muted' }
      // Off because the box said so is a state, not a fault.
      if (!s.awakeHold && !s.policy.awakeHold) return { chip: 'may sleep', tone: 'muted' }
      if (!s.awakeHold) return { chip: 'hold OFF', tone: 'bad' }
      if (s.updateAvailable !== null || s.restartPending) return { chip: 'updating', tone: 'warn' }
      return { chip: 'held awake', tone: 'ok' }
    default:
      return { chip: 'found, not announced', tone: 'muted' }
  }
}

/**
 * Claude Code on the machine, in one line: what the tray reports through the
 * status page when it answers, the last hello's summary when it does not.
 * The Claude page's picker is where the rest is.
 */
function ClaudeCell({ m }: { m: Machine }) {
  const s = m.status
  const c = s?.claude ?? null
  if (c !== null) {
    const version = c.serverVersion ?? c.cliVersion
    return c.state === 'running' || c.state === 'starting' ? (
      <Line>
        <Chip tone="ok">remote control {c.state}</Chip>
        {version !== null && <Mono>{version}</Mono>}
        <span className={ASIDE}>
          {String(c.sessions)} session{c.sessions === 1 ? '' : 's'}
        </span>
      </Line>
    ) : (
      <Line>
        <Chip tone={c.state === 'off' ? 'muted' : 'warn'}>{c.state}</Chip>
        {c.detail !== null && <span className={ASIDE}>{c.detail}</span>}
      </Line>
    )
  }
  if (s !== null && !agentHasClaude(s.version)) {
    return <span className={ASIDE}>needs agent 0.4.0 (has {s.version})</span>
  }
  if (s !== null && !s.trayReporting) {
    return (
      <span className={ASIDE}>
        {s.policy.claudeRemoteControl ? 'nobody logged on — the tray is not reporting' : '—'}
      </span>
    )
  }
  const h = m.node?.claude ?? null
  if (h !== null) {
    return (
      <span className={ASIDE}>
        {h.state}
        {h.serverVersion !== null && ` ${h.serverVersion}`} · {String(h.sessions)} session
        {h.sessions === 1 ? '' : 's'} · from the last hello
      </span>
    )
  }
  return <span className={ASIDE}>—</span>
}

/** The box's decision about the machine, and the buttons that change it. */
function Decision({ m }: { m: Machine }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const node = m.node
  const act = (fn: (opts: { data: { id: string } }) => Promise<unknown>) => {
    if (node === null) return
    setError(null)
    start(async () => {
      try {
        await fn({ data: { id: node.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  if (node === null) {
    return (
      <p className={NOTE}>
        Its status page answers but no hello has reached the box, so there is no key to trust: the
        agent is older than 0.3.0, or it cannot find the box in DNS. It will announce itself on its
        next update; nothing to press here.
      </p>
    )
  }

  const line =
    node.state === 'pending'
      ? `Announced itself ${since(node.lastSeenAgo)} and is waiting for a decision. Approve it if this is your machine.`
      : node.state === 'approved'
        ? `Approved ${node.approvedAt !== null ? since((Date.now() - Date.parse(node.approvedAt)) / 1000) : ''}${node.approvedBy !== null ? ` by ${node.approvedBy}` : ''}; last hello ${since(node.lastSeenAgo)}.${node.updateCheckRequested ? ' An update is queued for its next hello: the agent reads the release feed and installs what it finds.' : ''}`
        : `Revoked; the box ignores its hellos. Approve to trust its key again, or forget it.`

  return (
    <div className="flex flex-col gap-2">
      <p className={NOTE}>{line}</p>
      <div className="flex flex-wrap items-center gap-2">
        {node.state !== 'approved' && (
          <Button size="sm" disabled={busy} onClick={() => act(approveNodeFn)}>
            Approve
          </Button>
        )}
        {node.state === 'approved' && (
          <>
            {/* Rides the next hello's answer, so within a minute. */}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || node.updateCheckRequested}
              onClick={() => act(requestUpdateCheckFn)}
            >
              {node.updateCheckRequested ? 'Update queued' : 'Update now'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(revokeNodeFn)}>
              Revoke
            </Button>
          </>
        )}
        {node.state !== 'approved' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(forgetNodeFn)}>
            Forget
          </Button>
        )}
        <span
          className={cn(MONO, 'text-[0.7rem] text-(--dim)')}
          title="sha256 of the machine's public key, the first 16 hex digits: what the box trusts"
        >
          key {node.id}
        </span>
      </div>
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </div>
  )
}

/** The dropdown value for "no part chosen": Radix refuses an empty string. */
const NONE = '—'

/** What the box asks of an approved machine. Each row saves on its own. */
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
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
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

function Policy({
  n,
  shape,
  lanDomain,
}: {
  n: NodeRow
  shape: MachineShape | null
  lanDomain: string
}) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // The name is typed, so it is held here and saved on blur or Enter; the
  // switches save on click.
  const [name, setName] = useState(n.policy.displayName ?? '')
  const [netName, setNetName] = useState(n.policy.name ?? '')
  // A port field per kind: typed, so held here and saved on blur, the way
  // the names are. Adding a kind to NODE_PROVIDER_KINDS fills this in.
  const [ports, setPorts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      NODE_PROVIDER_KINDS.map((k) => [k, String(n.policy.providers?.[k]?.port ?? DEFAULT_PORT[k])]),
    ),
  )
  const [workdir, setWorkdir] = useState(n.policy.claudeWorkdir ?? '')

  // The policy the next save builds on: what the page last saved, until the
  // reload brings the row back. Two quick edits — a name, then a switch —
  // would otherwise each start from the row as it was before both, and the
  // second would silently undo the first.
  const base = useRef<NodePolicy>(n.policy)
  useEffect(() => {
    base.current = n.policy
  }, [n.policy])
  const save = (policy: NodePolicy) => {
    base.current = policy
    setError(null)
    start(async () => {
      try {
        await saveNodePolicyFn({ data: { id: n.id, policy } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  const saveName = () => {
    const trimmed = name.trim()
    if (trimmed === (base.current.displayName ?? '')) return
    const { displayName: _old, ...rest } = base.current
    save(trimmed === '' ? rest : { ...rest, displayName: trimmed })
  }
  // The network name: a label, or empty for the hostname's slug. Checked
  // here so a bad one never leaves the field, and again on the server.
  const netNameBad = netName !== '' && !NODE_NAME_RE.test(netName)
  const saveNetName = () => {
    const trimmed = netName.trim().toLowerCase()
    setNetName(trimmed)
    if (trimmed === (base.current.name ?? '') || (trimmed !== '' && !NODE_NAME_RE.test(trimmed))) {
      return
    }
    const { name: _old, ...rest } = base.current
    save(trimmed === '' ? rest : { ...rest, name: trimmed })
  }
  const providerOf = (kind: ProviderKind): { port: number; offer: boolean } => {
    const p = n.policy.providers?.[kind]
    return { port: p?.port ?? DEFAULT_PORT[kind], offer: p?.offer ?? false }
  }
  const saveProvider = (kind: ProviderKind, next: { port: number; offer: boolean }) => {
    const models = base.current.providers?.[kind]?.models
    save({
      ...base.current,
      providers: {
        ...base.current.providers,
        [kind]: models === undefined ? next : { ...next, models },
      },
    })
  }
  // The per-model curation rides the same policy: one model's change,
  // merged into what was last saved (never the row from before the previous
  // save — two aliases typed a second apart would undo each other).
  const changeModel = (kind: ProviderKind, id: string, patch: ModelPolicy) => {
    const stored = base.current.providers?.[kind]
    const current = { ...providerOf(kind), ...stored }
    const models = current.models ?? {}
    const next: ModelPolicy = { ...models[id], ...patch }
    for (const k of Object.keys(next) as (keyof ModelPolicy)[]) {
      if (next[k] === undefined) delete next[k]
    }
    const { [id]: _old, ...others } = models
    const merged = Object.keys(next).length === 0 ? others : { ...others, [id]: next }
    const { models: _m, ...rest } = current
    save({
      ...base.current,
      providers: {
        ...base.current.providers,
        [kind]: Object.keys(merged).length === 0 ? rest : { ...rest, models: merged },
      },
    })
  }
  const savePort = (kind: ProviderKind) => {
    const current = providerOf(kind)
    const p = Number(ports[kind])
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      setPorts((was) => ({ ...was, [kind]: String(current.port) }))
      return
    }
    if (p !== current.port) saveProvider(kind, { ...current, port: p })
  }
  const saveHardware = (
    key: keyof NonNullable<NodePolicy['hardware']>,
    value: string | undefined,
  ) => {
    const { [key]: _old, ...rest } = base.current.hardware ?? {}
    const hardware = value === undefined ? rest : { ...rest, [key]: value }
    const { hardware: _h, ...policy } = base.current
    save(Object.keys(hardware).length === 0 ? policy : { ...policy, hardware })
  }
  // What the machine is decides what is worth asking. A Mac is a laptop
  // whatever the chassis field says; the model names its finishes.
  const laptop = shape?.form === 'laptop' || n.os === 'macos'
  const finishes = finishesFor(shape?.model)
  const saveWorkdir = () => {
    const trimmed = workdir.trim()
    if (trimmed === (base.current.claudeWorkdir ?? '')) return
    const { claudeWorkdir: _old, ...rest } = base.current
    save(trimmed === '' ? rest : { ...rest, claudeWorkdir: trimmed })
  }
  const updateClaude = () => {
    setError(null)
    start(async () => {
      try {
        await requestClaudeUpdateFn({ data: { id: n.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  const restartClaude = () => {
    setError(null)
    start(async () => {
      try {
        await requestClaudeRestartFn({ data: { id: n.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  // Shown as flipped the moment they are, while the save runs (lib/shown.ts).
  const failed = error !== null
  const [awake, showAwake] = useShown(n.policy.awakeHold ?? DEFAULTS.awakeHold, busy, failed)
  const [claude, showClaude] = useShown(
    n.policy.claudeRemoteControl ?? DEFAULTS.claudeRemoteControl,
    busy,
    failed,
  )

  return (
    <div className="flex flex-col gap-3 border-(--border-soft) border-t pt-4">
      <h3 className={cn(FIELD_LABEL, 'm-0')}>Policy</h3>
      <Rows
        rows={[
          {
            k: 'Display name',
            v: (
              <Stack className="w-full max-w-[22rem]">
                <Input
                  value={name}
                  placeholder={n.hostname}
                  maxLength={40}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
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
                    value={netName}
                    placeholder={slugOf(n.hostname)}
                    maxLength={32}
                    disabled={busy}
                    aria-invalid={netNameBad}
                    aria-label="Name on the network"
                    onChange={(e) => setNetName(e.target.value)}
                    onBlur={saveNetName}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                  <Mono>
                    {netName || slugOf(n.hostname)}.{lanDomain}
                  </Mono>
                </span>
                <span className={ASIDE}>
                  {netNameBad
                    ? 'Letters, digits and hyphens, 1 to 32 long, not starting or ending with a hyphen.'
                    : n.namedByHousehold
                      ? `The household reservations already name this machine's MAC; pi-hole keeps that name, and this one goes to site/nodes.json only, until the household line is removed.`
                      : 'pi-hole gives the lease this name, so the address can be whatever the pool hands out. Empty means the hostname as a label. Nix reads it from site/nodes.json on the next Apply.'}
                </span>
              </Stack>
            ),
          },
          ...NODE_PROVIDER_KINDS.map((kind) => ({
            k: PROVIDER_NAME[kind],
            v: (
              <ProviderRow
                key={kind}
                kind={kind}
                nodeId={n.id}
                host={`${netName || slugOf(n.hostname)}.${lanDomain}`}
                offered={providerOf(kind).offer}
                port={ports[kind] ?? String(DEFAULT_PORT[kind])}
                busy={busy}
                failed={failed}
                onOffer={(v) => saveProvider(kind, { ...providerOf(kind), offer: v })}
                onPort={(v) => setPorts((was) => ({ ...was, [kind]: v }))}
                onPortDone={() => savePort(kind)}
                onModel={(id, patch) => changeModel(kind, id, patch)}
              />
            ),
          })),
          {
            k: 'Keep awake',
            v: (
              <Stack>
                <span className="inline-flex items-center gap-3">
                  <Switch
                    checked={awake}
                    disabled={busy}
                    onCheckedChange={(v) => {
                      showAwake(v)
                      save({ ...base.current, awakeHold: v })
                    }}
                    aria-label="Keep awake"
                  />
                  <span className="text-[0.82rem]">{awake ? 'held awake' : 'may sleep'}</span>
                </span>
                <span className={ASIDE}>
                  On, the agent holds a power request for as long as it runs and turns the plan's
                  sleep timers off. Off releases the request; the plan is left as it is.
                </span>
              </Stack>
            ),
          },
          {
            k: 'Claude remote control',
            v: (
              <Stack>
                <span className="inline-flex flex-wrap items-center gap-3">
                  <Switch
                    checked={claude}
                    disabled={busy}
                    onCheckedChange={(v) => {
                      showClaude(v)
                      save({ ...base.current, claudeRemoteControl: v })
                    }}
                    aria-label="Claude remote control"
                  />
                  <span className="text-[0.82rem]">{claude ? 'runs' : 'off'}</span>
                  {/* Update first, then restart: that is the order they are
                      used in, and the cheap one should not be reached past
                      the expensive one. */}
                  {claude && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || n.claudeUpdateRequested}
                      onClick={updateClaude}
                    >
                      {n.claudeUpdateRequested ? 'Update queued' : 'Update now'}
                    </Button>
                  )}
                  {claude && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || n.claudeRestartRequested}
                      onClick={restartClaude}
                    >
                      {n.claudeRestartRequested ? 'Restart queued' : 'Restart now'}
                    </Button>
                  )}
                </span>
                <span className={ASIDE}>
                  The agent's tray runs <Mono>claude remote-control</Mono> in the user's session,
                  with that user's Claude login, the way this box runs its own.
                </span>
              </Stack>
            ),
          },
          {
            k: 'Claude working directory',
            v: (
              <Stack className="w-full max-w-[28rem]">
                <Input
                  value={workdir}
                  placeholder="the most recently used trusted project"
                  maxLength={260}
                  disabled={busy}
                  onChange={(e) => setWorkdir(e.target.value)}
                  onBlur={saveWorkdir}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                />
                <span className={ASIDE}>
                  Where the server runs, and so where a session opened from claude.ai lands. Claude
                  refuses the home directory (home-directory trust is never saved), so this must be
                  a project directory <Mono>claude</Mono> has been run in once and trusted. Empty
                  lets the tray pick the trusted project used most recently.
                </span>
              </Stack>
            ),
          },
          // The parts nothing in the machine reports. A desktop gets a
          // dropdown per kind over the catalog (lib/hardware/catalog.ts) —
          // case, cooler, supply — and the Build tab draws what is chosen.
          // A laptop IS its case, cooler and supply, and reports every part
          // but its colour, so it gets the one thing left to ask: the finish.
          ...(laptop
            ? finishes.length === 0
              ? []
              : [
                  {
                    k: 'Finish',
                    v: (
                      <Stack className="w-full max-w-[28rem]">
                        <Picker
                          value={n.policy.hardware?.finish ?? NONE}
                          busy={busy}
                          failed={failed}
                          disabled={busy}
                          aria-label="finish"
                          options={[
                            { value: NONE, label: 'not set' },
                            ...finishes.map((f) => ({ value: f.id, label: f.name })),
                          ]}
                          onChange={(v) => {
                            saveHardware('finish', v === NONE ? undefined : v)
                          }}
                        />
                        <span className={ASIDE}>
                          The machine reports its model and everything in it; the colour is the one
                          thing it does not say. The pages draw the photo that matches.
                        </span>
                      </Stack>
                    ),
                  },
                ]
            : CHOSEN_KINDS.map((kind) => ({
                k: kind === 'case' ? 'Case' : kind === 'cooler' ? 'CPU cooler' : 'Power supply',
                v: (
                  <Stack className="w-full max-w-[28rem]">
                    <Picker
                      value={n.policy.hardware?.[kind] ?? NONE}
                      busy={busy}
                      failed={failed}
                      disabled={busy}
                      aria-label={kind}
                      options={[
                        { value: NONE, label: 'not set' },
                        ...partsOfKind(kind).map((p) => ({ value: p.id, label: p.name })),
                      ]}
                      onChange={(v) => {
                        saveHardware(kind, v === NONE ? undefined : v)
                      }}
                    />
                    {kind === 'psu' && (
                      <span className={ASIDE}>
                        Nothing in a PC reports its case, cooler or supply, so these are chosen
                        rather than read; the Build tab draws what is chosen, with the catalog's
                        photo and specification. A part that is not on the list is a line in the
                        catalog.
                      </span>
                    )}
                  </Stack>
                ),
              }))),
        ]}
      />
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </div>
  )
}

/** One machine: the head, the facts, the decision, and — once approved — the policy. */
function MachineSection({ m, port, lanDomain }: { m: Machine; port: number; lanDomain: string }) {
  const s = m.status
  const os = s?.os ?? m.node?.os ?? ''
  const mark = osMark(os)
  const edition = s?.osName || (os ? os.charAt(0).toUpperCase() + os.slice(1) : 'unknown OS')
  const version = s?.osVersion ?? ''
  const arch = s?.arch || m.node?.arch || ''
  const v = verdict(m)

  const facts = [
    { k: 'Agent', v: <Mono>{s?.version ?? m.node?.agentVersion ?? '—'}</Mono> },
    ...(s?.cpu ? [{ k: 'Processor', v: <Mono>{s.cpu}</Mono> }] : []),
    ...(s?.memoryBytes != null ? [{ k: 'Memory', v: <Mono>{bytes(s.memoryBytes)}</Mono> }] : []),
    {
      k: 'Machine up',
      v: <Mono>{s?.osUptimeSecs == null ? '—' : duration(s.osUptimeSecs)}</Mono>,
    },
    { k: 'Claude', v: <ClaudeCell m={m} /> },
    {
      k: 'Updates',
      v:
        s === null ? (
          <span className={ASIDE}>—</span>
        ) : s.restartPending ? (
          <Chip tone="warn">installed, restarting</Chip>
        ) : s.updateAvailable !== null ? (
          <Chip tone="warn">{s.updateAvailable} available</Chip>
        ) : (
          <span className={ASIDE}>
            {s.lastUpdateResult ?? 'not checked yet'}
            {s.lastUpdateCheck !== null &&
              ` · ${since((Date.now() - Date.parse(s.lastUpdateCheck)) / 1000)}`}
          </span>
        ),
    },
    {
      k: 'Address',
      v:
        m.ip === null ? (
          <span className={ASIDE}>—</span>
        ) : (
          <a
            href={`http://${m.ip}:${String(port)}/status`}
            target="_blank"
            rel="noreferrer"
            className={cn(MONO, 'hover:text-foreground')}
          >
            {m.ip}:{port}
          </a>
        ),
    },
    ...(m.node?.mac != null ? [{ k: 'Hardware address', v: <Mono>{m.node.mac}</Mono> }] : []),
  ]

  return (
    <Section
      title={m.node?.name || s?.hostname || m.lanName || m.ip || 'Machine'}
      icon={
        mark === null ? (
          <MonitorSmartphoneIcon />
        ) : (
          <img
            src={mark.src}
            alt=""
            width={20}
            height={20}
            className={cn('size-5 flex-none object-contain', mark.invert && 'dark:invert')}
          />
        )
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Chip tone={v.tone}>{v.chip}</Chip>
          <span>
            {edition}
            {version !== '' && ` · ${version}`}
            {arch !== '' && ` · ${arch}`}
          </span>
        </span>
      }
      rows={facts}
    >
      {s?.holdError != null && <p className={NOTE}>The hold failed: {s.holdError}</p>}
      <Decision m={m} />
      {m.node !== null && m.node.state === 'approved' && (
        <Policy n={m.node} shape={m.shape} lanDomain={lanDomain} />
      )}
    </Section>
  )
}

export function Machines({ d }: { d: MachinesData }) {
  return (
    <div className="flex flex-col gap-6">
      {d.machines.length === 0 ? (
        <Section
          title="Machines"
          icon={<MonitorSmartphoneIcon />}
          description="No machine has announced itself yet."
        >
          <p className={NOTE}>
            {d.error !== null
              ? `The LAN device list could not be read: ${d.error}`
              : `None of the ${String(d.probed)} devices asked answered the agent's status page either. Install the agent on a machine and it appears here.`}
          </p>
        </Section>
      ) : (
        d.machines.map((m) => (
          <MachineSection
            key={m.node?.id ?? m.ip ?? m.lanName ?? ''}
            m={m}
            port={d.port}
            lanDomain={d.lanDomain}
          />
        ))
      )}

      <Section
        title="The gateway"
        icon={<MonitorSmartphoneIcon />}
        description="What every provider above offers becomes a route in LiteLLM, kept in step by the box."
      >
        <Rows
          rows={[
            { k: 'This box', v: <BoxProvider /> },
            { k: 'Sync', v: <GatewaySync /> },
          ]}
        />
      </Section>

      <Section title="How a machine joins" icon={<MonitorSmartphoneIcon />}>
        <p className={NOTE}>Install the agent on it. Windows, from an administrator PowerShell:</p>
        <p className={cn(MONO, 'm-0 select-all')}>{INSTALL_WINDOWS}</p>
        <p className={NOTE}>A Mac, from a terminal:</p>
        <p className={cn(MONO, 'm-0 select-all')}>{INSTALL_MACOS}</p>
        <p className={NOTE}>
          The agent keeps the machine awake, shows itself in the tray or the menu bar, updates
          itself from each release, and announces itself to this box every minute with a key it made
          at install — the machine then appears above as "wants to join" until you approve it. The
          page also asks every device pi-hole has seen in the last week for the agent's status page
          on TCP {String(d.port)} ({String(d.probed)} asked just now
          {d.skipped > 0 && `, ${String(d.skipped)} too long silent`}), so an agent that cannot find
          the box is still seen.
        </p>
      </Section>

      <p className={NOTE}>
        Each switch reaches its machine on the agent's next hello, within a minute. Approve, revoke
        and update take effect the same way.
      </p>
    </div>
  )
}
