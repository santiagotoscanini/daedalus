import { useEffect, useRef, useState } from 'react'

import type { NodePolicy } from '../../../host/schema'
import { POLICY_DEFAULTS } from '../../../lib/agent/policy'
import { NODE_NAME_RE } from '../../../lib/nodes-file'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../../../lib/providers/kinds'
import type { ModelPolicy } from '../../../lib/providers/policy'
import type { NodeRow } from '../../../lib/repo/nodes'
import { useShown } from '../../../lib/shown'
import { saveNodePolicyFn } from '../../../server/nodes'
import { useAction } from '../../use-action'

// The state behind an approved machine's Policy card: the typed fields, the
// switches shown optimistically, and one save per edit. A save is a change
// by key (lib/repo/nodes.ts `PolicyPatch`): the key the edit is about, and
// nothing else, so a change the machine asked for from its menu bar while
// this page was open is never undone by an edit of another key here. The
// two keys whose value is a whole object — providers, hardware — are built
// on the policy the page last saved, so two quick edits of the same object
// chain. santree ON is not a save: the switch opens the confirmation
// (./santree-grant.tsx), as the Mac's "santree on the box" does. The card
// itself (./policy.tsx) only draws what this holds.

export type PolicyEditor = ReturnType<typeof usePolicyEditor>

/** A change by key: the keys to set, the keys to clear. */
type Patch = { set: NodePolicy; unset: (keyof NodePolicy)[] }

/** `p` with `patch` applied, as the row will hold it. */
function applied(p: NodePolicy, patch: Patch): NodePolicy {
  const next: NodePolicy = { ...p, ...patch.set }
  for (const k of patch.unset) delete next[k]
  return next
}

/** One key set, or cleared when `value` is undefined. */
function only<K extends keyof NodePolicy>(key: K, value: NodePolicy[K] | undefined): Patch {
  return value === undefined ? { set: {}, unset: [key] } : { set: { [key]: value }, unset: [] }
}

export function usePolicyEditor(n: NodeRow, opts: { askSantree?: boolean } = {}) {
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

  // The policy as the page last saved it, until the reload brings the row
  // back: what the whole-object keys build on, and what the typed fields
  // compare against.
  const base = useRef<NodePolicy>(n.policy)
  useEffect(() => {
    base.current = n.policy
  }, [n.policy])
  const save = (patch: Patch) => {
    base.current = applied(base.current, patch)
    run(() => saveNodePolicyFn({ data: { id: n.id, set: patch.set, unset: patch.unset } }))
  }
  const saveName = () => {
    const trimmed = name.trim()
    if (trimmed === (base.current.displayName ?? '')) return
    save(only('displayName', trimmed === '' ? undefined : trimmed))
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
    save(only('name', trimmed === '' ? undefined : trimmed))
  }
  const providerOf = (kind: ProviderKind): { port: number; offer: boolean } => {
    const p = n.policy.providers?.[kind]
    return { port: p?.port ?? DEFAULT_PORT[kind], offer: p?.offer ?? false }
  }
  const saveProvider = (kind: ProviderKind, next: { port: number; offer: boolean }) => {
    const models = base.current.providers?.[kind]?.models
    save(
      only('providers', {
        ...base.current.providers,
        [kind]: models === undefined ? next : { ...next, models },
      }),
    )
  }
  // The per-model curation rides the same key: one model's change, merged
  // into the providers the page last saved.
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
    save(
      only('providers', {
        ...base.current.providers,
        [kind]: Object.keys(merged).length === 0 ? rest : { ...rest, models: merged },
      }),
    )
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
    save(only('hardware', Object.keys(hardware).length === 0 ? undefined : hardware))
  }
  const saveWorkdir = () => {
    const trimmed = workdir.trim()
    if (trimmed === (base.current.claudeWorkdir ?? '')) return
    save(only('claudeWorkdir', trimmed === '' ? undefined : trimmed))
  }

  // Shown as flipped the moment they are, while the save runs (lib/shown.ts).
  const failed = error !== null
  const [awake, showAwake] = useShown(n.policy.awakeHold ?? POLICY_DEFAULTS.awakeHold, busy, failed)
  const [claude, showClaude] = useShown(
    n.policy.claudeRemoteControl ?? POLICY_DEFAULTS.claudeRemoteControl,
    busy,
    failed,
  )
  const [santree, showSantree] = useShown(n.policy.santree ?? POLICY_DEFAULTS.santree, busy, failed)
  const setAwake = (v: boolean) => {
    showAwake(v)
    save(only('awakeHold', v))
  }
  const setClaude = (v: boolean) => {
    showClaude(v)
    save(only('claudeRemoteControl', v))
  }
  // ON asks first (the confirmation); OFF is a save like the others.
  const [askingSantree, setAskingSantree] = useState(
    opts.askSantree === true && n.policy.santree !== true,
  )
  const setSantree = (v: boolean) => {
    if (v) {
      setAskingSantree(true)
      return
    }
    setAskingSantree(false)
    showSantree(false)
    save(only('santree', false))
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
    santree,
    setSantree,
    askingSantree,
    closeSantree: () => setAskingSantree(false),
  }
}
