import { useEffect, useRef, useState } from 'react'

import type { NodePolicy } from '../../../host/schema'
import { NODE_NAME_RE } from '../../../lib/nodes-file'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../../../lib/providers/kinds'
import type { ModelPolicy } from '../../../lib/providers/policy'
import type { NodeRow } from '../../../lib/repo/nodes'
import { useShown } from '../../../lib/shown'
import {
  requestClaudeRestartFn,
  requestClaudeUpdateFn,
  saveNodePolicyFn,
} from '../../../server/nodes'
import { useAction } from '../../use-action'

// The state behind an approved machine's Policy card: the typed fields, the
// switches shown optimistically, and one save per edit — every save built on
// the policy the page last saved, never on the row as it was loaded. The card
// itself (./policy.tsx) only draws what this holds.

/** The agent's own defaults, which a key the policy leaves unset falls back to. */
const DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

export type PolicyEditor = ReturnType<typeof usePolicyEditor>

export function usePolicyEditor(n: NodeRow) {
  const { run, busy, error } = useAction()
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
    run(() => saveNodePolicyFn({ data: { id: n.id, policy } }))
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
  // The per-model curation rides the same policy: one model's change, merged
  // into `base` like every other save.
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
  const setPort = (kind: ProviderKind, v: string) => {
    setPorts((was) => ({ ...was, [kind]: v }))
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
  const saveWorkdir = () => {
    const trimmed = workdir.trim()
    if (trimmed === (base.current.claudeWorkdir ?? '')) return
    const { claudeWorkdir: _old, ...rest } = base.current
    save(trimmed === '' ? rest : { ...rest, claudeWorkdir: trimmed })
  }
  const updateClaude = () => {
    run(() => requestClaudeUpdateFn({ data: { id: n.id } }))
  }
  const restartClaude = () => {
    run(() => requestClaudeRestartFn({ data: { id: n.id } }))
  }

  // Shown as flipped the moment they are, while the save runs (lib/shown.ts).
  const failed = error !== null
  const [awake, showAwake] = useShown(n.policy.awakeHold ?? DEFAULTS.awakeHold, busy, failed)
  const [claude, showClaude] = useShown(
    n.policy.claudeRemoteControl ?? DEFAULTS.claudeRemoteControl,
    busy,
    failed,
  )
  const setAwake = (v: boolean) => {
    showAwake(v)
    save({ ...base.current, awakeHold: v })
  }
  const setClaude = (v: boolean) => {
    showClaude(v)
    save({ ...base.current, claudeRemoteControl: v })
  }

  return {
    busy,
    error,
    failed,
    name,
    setName,
    saveName,
    netName,
    setNetName,
    netNameBad,
    saveNetName,
    ports,
    setPort,
    savePort,
    providerOf,
    saveProvider,
    changeModel,
    saveHardware,
    workdir,
    setWorkdir,
    saveWorkdir,
    awake,
    setAwake,
    claude,
    setClaude,
    updateClaude,
    restartClaude,
  }
}
