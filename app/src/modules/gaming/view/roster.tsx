import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { Board, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { useShown } from '../../../lib/shown'
import { addPlayerFn, removePlayerFn, setPlayerOpFn } from '../../../server/players'
import type { GamingData } from '../data'

// Who may join the Minecraft server, edited in place.
//
// Every control is a site edit (site.json `modules.players.minecraft`) and
// lands on the next Apply, like the cog's: it writes the draft, says what the
// draft would do, and rebuilds nothing. A name is resolved against Mojang
// before it is written, so what goes in is an account, never a guess.

type Row = Extract<GamingData, { tab: 'minecraft' }>['roster'][number]

const LIST = 'm-0 flex list-none flex-col gap-[0.3rem] p-0'
const ROW = cn(
  'grid min-w-0 grid-cols-[2rem_1fr_auto] items-center gap-x-[0.7rem] gap-y-[0.3rem]',
  'rounded-[8px] bg-(--panel-2) px-[0.55rem] py-[0.45rem]',
)
const HEAD = 'size-8 rounded-[5px] [image-rendering:pixelated]'
const HEAD_BLANK = cn(
  HEAD,
  'grid place-items-center bg-(--panel) text-[0.8rem] font-semibold text-muted-foreground',
)
const META = `${NOTE} flex flex-wrap gap-x-[0.6rem] gap-y-[0.1rem]`
const SIDE = 'flex flex-wrap items-center justify-end gap-[0.5rem]'
const INPUT = cn(
  'h-auto w-[13rem] max-w-full rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.35rem]',
  'font-mono md:text-[0.8rem] dark:bg-(--panel-2)',
)

const day = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function RosterBoard({ rows }: { rows: Row[] }) {
  const allowed = rows.filter((r) => r.state !== 'removing').length
  return (
    <Board
      title="Who gets in"
      icon="panels"
      span={12}
      aside={
        <span className={NOTE}>
          {allowed === 0 ? 'nobody' : `${String(allowed)} allowed`} · Java accounts
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className={EMPTY}>nobody is on the list, so the server turns every login away</p>
      ) : (
        <ul className={LIST}>
          {rows.map((r) => (
            <PlayerRow key={r.uuid} r={r} />
          ))}
        </ul>
      )}
      <AddPlayer />
      <p className={FOOT}>
        Kept in site.json (<span className={MONO}>modules.players.minecraft</span>) and applied on
        the next Apply. The server reloads its whitelist in place, so an Apply only kicks the people
        it removes. Every name is checked with Mojang before it goes on the list, and the server
        lets players in by UUID, so a player who renames still gets in.
      </p>
    </Board>
  )
}

function PlayerRow({ r }: { r: Row }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [op, showOp] = useShown(r.op, busy, error !== null)

  async function run(write: () => Promise<{ ok: true } | { ok: false; reason: string }>) {
    setBusy(true)
    setError(null)
    try {
      const out = await write()
      if (!out.ok) setError(out.reason)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removing = r.state === 'removing'
  return (
    <li className={cn(ROW, removing && 'opacity-60')}>
      {r.head === null ? (
        <span className={HEAD_BLANK} aria-hidden>
          {r.name.slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <img className={HEAD} src={r.head} alt="" width={32} height={32} />
      )}

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-[0.45rem]">
          <span className={cn('text-[0.85rem] font-medium', removing && 'line-through')}>
            {r.name}
          </span>
          {r.state === 'adding' && <Chip tone="info">joins on Apply</Chip>}
          {removing && <Chip tone="warn">leaves on Apply</Chip>}
          {r.opPending && <Chip tone="info">{r.op ? 'op on Apply' : 'not op on Apply'}</Chip>}
        </div>
        <div className={META}>
          <span className={MONO}>{r.uuid}</span>
          {r.renamed !== null && <span>now {r.renamed} on Mojang</span>}
          <span>
            {r.lastSeen === null ? 'not seen in 30 days' : `last joined ${day(r.lastSeen)}`}
          </span>
          {(r.model !== null || r.cape) && (
            <span>
              {[r.model === 'slim' ? 'slim arms' : r.model === 'classic' ? 'classic arms' : null]
                .concat(r.cape ? ['cape'] : [])
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        {error !== null && <p className={cn(NOTE, 'm-0 text-danger')}>{error}</p>}
      </div>

      <div className={SIDE}>
        {!removing && (
          <span className={cn(NOTE, 'flex items-center gap-[0.4rem]')}>
            op
            <Switch
              aria-label={`${r.name} may run commands`}
              checked={op}
              disabled={busy}
              onCheckedChange={(v) => {
                showOp(v)
                void run(() => setPlayerOpFn({ data: { id: 'minecraft', uuid: r.uuid, op: v } }))
              }}
            />
          </span>
        )}
        {removing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                addPlayerFn({ data: { id: 'minecraft', name: r.renamed ?? r.name, op: r.op } }),
              )
            }
          >
            Keep
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() => removePlayerFn({ data: { id: 'minecraft', uuid: r.uuid } }))
            }
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  )
}

function AddPlayer() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [op, setOp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '' || busy) return
    setBusy(true)
    setSaid(null)
    try {
      const out = await addPlayerFn({ data: { id: 'minecraft', name, op } })
      if (out.ok) {
        const got = out.player?.name ?? name.trim()
        setSaid({
          tone: 'ok',
          text:
            got === name.trim()
              ? `${got} found on Mojang; they get in after the next Apply`
              : `found on Mojang as ${got}; they get in after the next Apply`,
        })
        setName('')
        setOp(false)
        await router.invalidate()
      } else {
        setSaid({ tone: 'bad', text: out.reason })
      }
    } catch (err) {
      setSaid({ tone: 'bad', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="mt-[0.6rem] flex flex-wrap items-center gap-[0.6rem]">
      <Input
        className={INPUT}
        value={name}
        placeholder="Java username"
        aria-label="Java username to add"
        maxLength={16}
        disabled={busy}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onChange={(e) => setName(e.target.value)}
      />
      <span className={cn(NOTE, 'flex items-center gap-[0.4rem]')}>
        op
        <Switch aria-label="Add as op" checked={op} disabled={busy} onCheckedChange={setOp} />
      </span>
      <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
        {busy ? 'Checking with Mojang…' : 'Add'}
      </Button>
      {said !== null && (
        <span className={cn(NOTE, said.tone === 'bad' && 'text-danger')}>{said.text}</span>
      )}
    </form>
  )
}
