import { type FormEvent, useState } from 'react'
import { DAY, LocalTime } from '../../../components/ago'
import { BOARD_TABLE, BOARD_TABLE_HEAD, BOARD_TABLE_ROW } from '../../../components/modules/parts'
import { CELL_NAME, CELL_QUIET, CELL_SUB } from '../../../components/table'
import { EMPTY, FOOT, INPUT_MONO, MONO, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { useAction } from '../../../components/use-action'
import { Board, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH } from '../../../lib/format'
import { useShown } from '../../../lib/shown'
import { addPlayerFn, removePlayerFn, setPlayerOpFn } from '../../../server/players'
import type { GamingData } from '../data'

// Who may join the Minecraft server, edited in place.
//
// Every control is a site edit (site.json `modules.players.minecraft`) and
// lands on the next Apply, like the service cog's
// (components/service-settings.tsx): it writes the draft, says what the
// draft would do, and rebuilds nothing. A name is resolved against Mojang
// before it is written, so what goes in is an account, never a guess.

type Row = Extract<GamingData, { tab: 'minecraft' }>['roster'][number]

/* The roster: the player, when they last joined, their skin, op, and the one action.
   Last joined and the skin step away first; op and the action never do. */
const GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.6fr)_8rem_7rem_3rem_5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_3rem_5rem]',
)
const HIDE_NARROW = '@max-[44rem]/table:hidden'
const HEAD = 'size-8 rounded-md [image-rendering:pixelated]'
const HEAD_BLANK = cn(
  HEAD,
  'grid place-items-center bg-foreground/[0.06] text-[0.8rem] font-semibold text-muted-foreground',
)
const INPUT = cn(INPUT_MONO, 'w-[13rem] max-w-full')

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
        <ul className={BOARD_TABLE}>
          <li className={cn(GRID, BOARD_TABLE_HEAD)}>
            <span>Player</span>
            <span className={HIDE_NARROW}>Last joined</span>
            <span className={HIDE_NARROW}>Skin</span>
            <span>Op</span>
            <span />
          </li>
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
  const { run, busy, error } = useAction()
  const [op, showOp] = useShown(r.op, busy, error !== null)

  const removing = r.state === 'removing'
  const skin = [r.model === 'slim' ? 'slim arms' : r.model === 'classic' ? 'classic arms' : null]
    .concat(r.cape ? ['cape'] : [])
    .filter(Boolean)
    .join(' · ')
  return (
    <li className={cn(GRID, BOARD_TABLE_ROW, 'py-2.5', removing && 'opacity-60')}>
      <div className="flex min-w-0 items-center gap-3">
        {r.head === null ? (
          <span className={HEAD_BLANK} aria-hidden>
            {r.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img className={HEAD} src={r.head} alt="" width={32} height={32} />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(CELL_NAME, removing && 'line-through')}>{r.name}</span>
            {r.state === 'adding' && <Chip tone="info">joins on Apply</Chip>}
            {removing && <Chip tone="warn">leaves on Apply</Chip>}
            {r.opPending && <Chip tone="info">{r.op ? 'op on Apply' : 'not op on Apply'}</Chip>}
          </div>
          <p className={cn(CELL_SUB, 'flex flex-wrap gap-x-2.5')}>
            <span className="truncate font-mono text-[0.7rem]">{r.uuid}</span>
            {r.renamed !== null && <span>now {r.renamed} on Mojang</span>}
          </p>
          {error !== null && <p className={cn(NOTE, 'm-0 text-danger')}>{error}</p>}
        </div>
      </div>

      <span className={cn(CELL_QUIET, HIDE_NARROW)}>
        {r.lastSeen === null ? 'not seen in 30 days' : <LocalTime at={r.lastSeen} opts={DAY} />}
      </span>
      <span className={cn(CELL_QUIET, 'truncate', HIDE_NARROW)}>{skin === '' ? DASH : skin}</span>

      <span className="flex items-center">
        {!removing && (
          <Switch
            aria-label={`${r.name} may run commands`}
            checked={op}
            disabled={busy}
            onCheckedChange={(v) => {
              showOp(v)
              run(() => setPlayerOpFn({ data: { id: 'minecraft', uuid: r.uuid, op: v } }))
            }}
          />
        )}
      </span>

      <span className="flex justify-end">
        {removing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(() =>
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
            onClick={() => run(() => removePlayerFn({ data: { id: 'minecraft', uuid: r.uuid } }))}
          >
            Remove
          </Button>
        )}
      </span>
    </li>
  )
}

function AddPlayer() {
  const [name, setName] = useState('')
  const [op, setOp] = useState(false)
  const { run, busy, error, notice } = useAction()

  function submit(e: FormEvent) {
    e.preventDefault()
    if (name.trim() === '' || busy) return
    const typed = name.trim()
    run(() => addPlayerFn({ data: { id: 'minecraft', name, op } }), {
      notice: (out) => {
        const got = out.player?.name ?? typed
        return got === typed
          ? `${got} found on Mojang; they get in after the next Apply`
          : `found on Mojang as ${got}; they get in after the next Apply`
      },
      onDone: () => {
        setName('')
        setOp(false)
      },
    })
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2.5">
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
      <span className={cn(NOTE, 'flex items-center gap-1.5')}>
        op
        <Switch aria-label="Add as op" checked={op} disabled={busy} onCheckedChange={setOp} />
      </span>
      <Button type="submit" size="sm" disabled={busy || name.trim() === ''}>
        {busy ? 'Checking with Mojang…' : 'Add'}
      </Button>
      {(error ?? notice) !== null && (
        <span className={cn(NOTE, error !== null && 'text-danger')}>{error ?? notice}</span>
      )}
    </form>
  )
}
