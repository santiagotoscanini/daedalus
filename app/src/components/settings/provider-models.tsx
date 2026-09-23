import { useEffect, useState, useTransition } from 'react'
import type { ProviderKind } from '../../lib/providers/kinds'
import { MODE_WORD, MODEL_MODES, type ModelPolicy } from '../../lib/providers/policy'
import { errorText } from '../../lib/redact'
import { useShown } from '../../lib/shown'
import {
  fetchBoxProvidersFn,
  fetchGatewaySyncFn,
  fetchProviderModelsFn,
  runGatewaySyncFn,
  saveBoxProvidersFn,
} from '../../server/nodes'
import { Bar } from '../skeleton'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Picker } from '../ui/picker'
import { Switch } from '../ui/switch'
import { Chip } from '../viz'
import { ASIDE, Mono, Stack } from './shared'

// The models a provider serves, as the operator curates them for the
// gateway: an alias, a switch, a mode — each row saved on its own, into the
// node's policy (Settings › Machines › the node) or, for this box's subgen,
// the box's own. The gateway sync reads the same policy; "Sync now" runs it
// and the line under the table says what the last run did.

type Row = Awaited<ReturnType<typeof fetchProviderModelsFn>>['models'][number]
type Catalog = Awaited<ReturnType<typeof fetchProviderModelsFn>>

const MODE_OPTIONS = MODEL_MODES.map((m) => ({ value: m, label: MODE_WORD[m] }))

function ModelRow({
  m,
  busy,
  failed,
  onChange,
}: {
  m: Row
  busy: boolean
  failed: boolean
  onChange: (p: ModelPolicy) => void
}) {
  const [alias, setAlias] = useState(m.alias)
  useEffect(() => setAlias(m.alias), [m.alias])
  const [offer, showOffer] = useShown(m.offer, busy, failed)
  const saveAlias = () => {
    const a = alias.trim().toLowerCase()
    setAlias(a)
    if (a === m.alias) return
    // The default alias is the absence of one.
    onChange({ alias: a === '' || a === m.defaultAlias ? undefined : a })
  }
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_9rem_10rem] items-center gap-3 border-(--border-soft) border-t py-[0.45rem] text-[0.8rem] first:border-t-0 max-[48rem]:grid-cols-[auto_minmax(0,1fr)] max-[48rem]:gap-y-1">
      <Switch
        checked={offer}
        disabled={busy || !m.downloaded}
        aria-label={`Offer ${m.id} to the gateway`}
        onCheckedChange={(v) => {
          showOffer(v)
          onChange({ offer: v })
        }}
      />
      <span className="min-w-0">
        <span className="block truncate">
          <Mono>{m.id}</Mono>
        </span>
        <span className={ASIDE}>
          {m.loaded ? 'loaded · ' : ''}
          {m.downloaded ? '' : 'not downloaded · '}
          {m.labels.join(', ') || 'no labels'}
          {m.sizeGb !== null && ` · ${String(m.sizeGb)} GB`}
        </span>
      </span>
      <Picker
        value={m.mode}
        options={MODE_OPTIONS}
        busy={busy}
        failed={failed}
        disabled={busy}
        aria-label={`Mode of ${m.id}`}
        onChange={(v) => onChange({ mode: v as ModelPolicy['mode'] })}
      />
      <Input
        value={alias}
        disabled={busy}
        aria-label={`Alias of ${m.id}`}
        placeholder={m.defaultAlias}
        className="font-mono text-[0.78rem]"
        onChange={(e) => setAlias(e.target.value)}
        onBlur={saveAlias}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    </li>
  )
}

/**
 * The table for one node's Lemonade. Each row hands ONE change up; the
 * page merges it into the policy it last saved, so two quick edits do not
 * undo each other.
 */
export function ProviderModels({
  nodeId,
  kind,
  busy,
  failed,
  change,
}: {
  nodeId: string
  kind: ProviderKind
  busy: boolean
  failed: boolean
  change: (id: string, patch: ModelPolicy) => void
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  useEffect(() => {
    let live = true
    fetchProviderModelsFn({ data: { id: nodeId, kind } }).then(
      (c) => {
        if (live) setCatalog(c)
      },
      () => {
        if (live)
          setCatalog({ reachable: false, error: 'could not read', version: null, models: [] })
      },
    )
    return () => {
      live = false
    }
  }, [nodeId, kind])

  if (catalog === null) {
    return (
      <Stack className="w-full">
        <Bar w="60%" h={12} />
        <Bar w="80%" h={12} />
        <Bar w="70%" h={12} />
      </Stack>
    )
  }
  if (!catalog.reachable) {
    return (
      <span className={ASIDE}>
        The provider did not answer{catalog.error !== null ? ` (${catalog.error})` : ''}; the
        gateway keeps what it had.
      </span>
    )
  }
  return (
    <Stack className="w-full">
      <ul className="m-0 list-none p-0">
        {catalog.models.map((m) => (
          <ModelRow
            key={m.id}
            m={m}
            busy={busy}
            failed={failed}
            onChange={(p) => change(m.id, p)}
          />
        ))}
      </ul>
      <span className={ASIDE}>
        {String(catalog.models.filter((m) => m.offer).length)} of {String(catalog.models.length)}{' '}
        offered
        {catalog.version !== null && ` · Lemonade ${catalog.version}`}. The alias is the model's
        name on the gateway; the mode is what the labels said unless changed here. Every change
        reaches the gateway on the next sync.
      </span>
    </Stack>
  )
}

/** "Sync now" and what the last run did. */
export function GatewaySync() {
  type Summary = Awaited<ReturnType<typeof fetchGatewaySyncFn>>
  const [last, setLast] = useState<Summary | undefined>(undefined)
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchGatewaySyncFn().then(setLast, () => setLast(null))
  }, [])
  const run = () => {
    setError(null)
    start(async () => {
      try {
        setLast(await runGatewaySyncFn())
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  const line =
    last === undefined
      ? null
      : last === null
        ? 'has not run yet in this process'
        : last.error !== null
          ? `failed: ${last.error}`
          : `${String(last.created.length)} created · ${String(last.updated.length)} updated · ${String(last.deleted.length)} removed · ${String(last.kept.length)} kept${last.skipped.length > 0 ? ` · ${String(last.skipped.length)} skipped` : ''}`
  return (
    <Stack className="w-full">
      <span className="inline-flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={run}>
          {busy ? 'Syncing…' : 'Sync now'}
        </Button>
        {line !== null && (
          <span className={ASIDE}>
            last sync {last?.at !== undefined ? new Date(last.at).toLocaleTimeString() : ''}: {line}
          </span>
        )}
      </span>
      {last?.skipped.map((s) => (
        <span key={s.alias} className={ASIDE}>
          skipped {s.alias}: {s.why}
        </span>
      ))}
      {error !== null && <span className="text-(--tone-bad) text-[0.78rem]">{error}</span>}
    </Stack>
  )
}

/** This box's own provider: subgen's whisper, offered or not, under an alias. */
export function BoxProvider() {
  type Box = Awaited<ReturnType<typeof fetchBoxProvidersFn>>
  const [box, setBox] = useState<Box | null>(null)
  const [alias, setAlias] = useState('')
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetchBoxProvidersFn().then((b) => {
      setBox(b)
      setAlias(b.policy.subgen?.models?.whisper?.alias ?? '')
    })
  }, [])
  const offered = box?.policy.subgen?.offer ?? false
  const [offer, showOffer] = useShown(offered, busy, error !== null)
  const save = (next: { offer: boolean; alias: string }) => {
    setError(null)
    start(async () => {
      try {
        await saveBoxProvidersFn({ data: { subgen: next } })
        setBox(await fetchBoxProvidersFn())
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  if (box === null) return <Bar w="50%" h={12} />
  if (!box.present) {
    return <span className={ASIDE}>The tv stack is off, so this box runs no provider.</span>
  }
  return (
    <Stack className="w-full max-w-[28rem]">
      <span className="inline-flex flex-wrap items-center gap-3">
        <Switch
          checked={offer}
          disabled={busy}
          aria-label="Offer subgen's whisper to the gateway"
          onCheckedChange={(v) => {
            showOffer(v)
            save({ offer: v, alias })
          }}
        />
        <span className="text-[0.82rem]">{offer ? 'offered to the gateway' : 'not offered'}</span>
        <span className="inline-flex items-center gap-2 text-[0.82rem]">
          alias
          <Input
            className="w-[10rem] font-mono text-[0.78rem]"
            value={alias}
            placeholder="whisper"
            disabled={busy}
            aria-label="Alias of the box's whisper"
            onChange={(e) => setAlias(e.target.value)}
            onBlur={() => save({ offer: offered, alias })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </span>
        <Chip tone="muted">speech to text</Chip>
      </span>
      <span className={ASIDE}>
        subgen's faster-whisper, the STT that makes Bazarr's subtitles, on port 9000 of this box.
        Offered, the gateway gets a transcription route to it beside the PC's whisper.
      </span>
      {error !== null && <span className="text-(--tone-bad) text-[0.78rem]">{error}</span>}
    </Stack>
  )
}
