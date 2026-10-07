// One roster row: its chip, name and side facts on the first line, the last
// prompt and the grouped metadata under it, and — where there is an honest
// one — its verb, armed in place.
import { ClockIcon, FolderGit2Icon, MessagesSquareIcon } from 'lucide-react'
import type { ActionOutcome } from '../../../host/controller/generated'
// Pure and client-safe — the whole reason the roster's types, its join and
// the row's derived facts live in lib/ rather than beside the loader. See the
// header of claude-roster.ts.
import { type FactIcon, factGroups, promptLine } from '../../../lib/claude-meta'
import { type RosterEntry, type RowControl, rowControl } from '../../../lib/claude-roster'
import { cn } from '../../../lib/cn'
import { DASH } from '../../../lib/format'
import { GHOST_BTN } from '../../apps/shared'
import { ArmedConfirm } from '../../armed-confirm'
import { MONO, ROW, ROW_MAIN, ROW_SIDE } from '../../tokens'
import { Button } from '../../ui/button'
import { Chip } from '../../viz'
import { working } from '../verdicts'
import { STATE_LABEL, STATE_TONE } from './tones'

/* The verb at the right edge OF the row, not under it: a button on a line of
   its own makes every row taller and a long list a ragged column. The rest of
   this page lays a row out as chip · name · facts, with anything actionable at
   the right edge, and this board reads as part of that page only if it does
   the same. `shrink-0` because the truncating side slots to its left would
   otherwise give away the button's width before their own. */
const ROW_BTN = 'ml-auto h-7 shrink-0 px-2.5 text-[0.75rem]'

/* The side column: how the row stands on its first line, the ids the CLI and
   claude.ai go by on its second. Right-aligned, so the ids form a column. */
const SIDE =
  'flex min-w-0 flex-col items-end gap-1 pt-0.5 max-[40rem]:col-span-2 max-[40rem]:row-start-2 max-[40rem]:items-start'
const SIDE_LINE =
  'flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 max-[40rem]:justify-start [&>span]:max-w-none [overflow-wrap:anywhere]'

/* ── the enriched row ─────────────────────────────────────────────────────

   Three lines: what it is, what was last said to it, and what is in it. The
   grouping is the design — a directory and a branch are one fact, a turn
   count and a file size are one fact, a span and an idle time are one story —
   and it lives in lib/claude-meta.ts so it can be tested without a DOM. */

/* The last prompt. One line, clipped, and in the muted ink the board uses for
   anything that is not a measurement, so it reads as context under the title
   rather than as a second title. */
const PROMPT =
  'm-0 mt-1 truncate text-[0.75rem] leading-[1.45] text-muted-foreground max-[40rem]:line-clamp-2 max-[40rem]:whitespace-normal!'

/* The metadata line. Wraps rather than scrolls — a row here is already a
   block, and a horizontal scrollbar inside one would be the third scroll axis
   on the page. The gap is wide enough that the groups read as groups without
   a separator glyph between them. */
const META =
  'mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.72rem] text-muted-foreground tabular-nums'
const META_ITEM = 'inline-flex min-w-0 max-w-full items-center gap-1'
const META_ICON = 'shrink-0 opacity-65'

/** The three groups that get a picture instead of a word. */
const FACT_ICONS: Record<FactIcon, typeof ClockIcon> = {
  where: FolderGit2Icon,
  size: MessagesSquareIcon,
  time: ClockIcon,
}

function FactIconFor({ name }: { name: FactIcon }) {
  const Icon = FACT_ICONS[name]
  return <Icon className={META_ICON} size={12} aria-hidden="true" />
}

/* What DOES belong under the row: the armed state. It carries a sentence
   about what the click costs, which is the one thing worth a second line. */
const CTRL = 'mt-2 flex flex-col items-start gap-1.5'
const CTRL_COST = 'text-[0.78rem] text-foreground leading-[1.5]'
const CTRL_NOTE = 'text-[0.72rem] text-muted-foreground leading-[1.5]'
const CTRL_STATE = 'm-0 mt-1.5 text-[0.75rem] leading-[1.5]'

type ActiveControl = Extract<RowControl, { session: string }>

/**
 * One row, and — where there is an honest one — its verb.
 *
 * Four kinds of row end four different ways and the rest (a session the server
 * spawned, an orphan) cannot be ended from here at all, so this deliberately
 * does not render one button for every row. `rowControl` makes that decision
 * (it is pure, and tested); this only draws it.
 */
export function RosterRow({
  row,
  acting,
  armed,
  busy,
  outcome,
  onArm,
  onCancel,
  onConfirm,
}: {
  row: RosterEntry
  /** This row sent the request the board is following. */
  acting: boolean
  armed: boolean
  busy: boolean
  /** The board's one followed request: how it stands, null before the first. */
  outcome: ActionOutcome | null
  onArm: () => void
  onCancel: () => void
  onConfirm: (control: ActiveControl) => void
}) {
  const control = rowControl(row)
  // The board follows one request, so only the row that sent it speaks —
  // otherwise every row would echo the same outcome.
  const mine = acting
  const prompt = promptLine(row.meta)

  return (
    <li
      className={cn(
        ROW,
        'px-5',
        // One grid for every row, so the facts and the verb sit in the same
        // columns down the whole roster: what it is (name, last prompt, its
        // metadata) · how it stands and its ids · the verb.
        'grid grid-cols-[minmax(0,1fr)_13rem_5rem] items-start gap-x-5 gap-y-0 py-3.5 [[data-group]+&]:border-t-0',
        // A phone stacks the row: the name and the verb on top, how it stands
        // and its ids as a full-width line beneath.
        'max-[40rem]:grid-cols-[minmax(0,1fr)_auto] max-[40rem]:gap-y-2',
      )}
      title={row.id ?? undefined}
    >
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          {/* The board groups rows by state and names each group once, so a
              row carries a chip only for the population that is a fault. */}
          {row.state === 'orphan' && (
            <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
          )}
          {/* A transcript with no name is titled by what was first asked of it,
              the raw id demoted to the ids line below. */}
          <span
            className={cn(
              ROW_MAIN,
              'text-[0.84rem] [font-weight:520] max-[40rem]:whitespace-normal! max-[40rem]:[text-overflow:clip]',
            )}
            title={row.label}
          >
            {preview(row) ?? row.label}
          </span>
        </div>

        {/* The one line of conversation on this page, and it gets a line of
            its own because it is the only thing here that is not a
            measurement. Quiet ink and a smaller size: it is context for the
            title above it, not a heading of its own. Redacted twice —
            host-side before it was written to a 0600 file, and again by
            `promptLine` on the way here. */}
        {prompt !== null && preview(row) === null && (
          <p className={PROMPT} title={prompt}>
            {prompt}
          </p>
        )}

        <RowMetaLine row={row} />
        <RowIds row={row} />
      </div>

      <RowSideFacts row={row} control={control} />

      {/* The verb, in its own column so every button on the roster lines up.
          It is hidden while armed because Confirm and Cancel take its place
          below — two buttons for one row at once is the ambiguity the
          two-step exists to avoid. */}
      <div className="flex justify-end">
        {control.kind !== 'none' && !busy && !armed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(GHOST_BTN, ROW_BTN)}
            onClick={onArm}
          >
            {control.kind === 'resume'
              ? 'Resume'
              : control.kind === 'remove-agent'
                ? 'Remove'
                : 'Stop'}
          </Button>
        )}
      </div>

      {mine && outcome !== null && (
        <div className="col-span-full">
          <RowOutcome outcome={outcome} />
        </div>
      )}

      {control.kind !== 'none' && !busy && armed && (
        <ArmedConfirm
          className={cn(CTRL, 'col-span-full')}
          costClassName={CTRL_COST}
          noteClassName={CTRL_NOTE}
          cost={<ArmedCost control={control} />}
          variant={control.kind === 'resume' ? 'default' : 'destructive'}
          confirm={
            control.kind === 'resume'
              ? 'Confirm resume'
              : control.kind === 'remove-agent'
                ? 'Confirm remove'
                : 'Confirm stop'
          }
          onConfirm={() => {
            onConfirm(control)
          }}
          onCancel={onCancel}
        />
      )}
    </li>
  )
}

/** The first line's side slots, after the name and before the verb. */
function RowSideFacts({ row, control }: { row: RosterEntry; control: RowControl }) {
  // `busy` is the CLI saying it is mid-turn, which no clock can infer. The
  // fallback is "touched within the last minute" (`working`, verdicts.ts), the
  // honest reading of active for a session being driven from a phone. Only
  // ever shown for a row with a process.
  const lifecycle = row.lifecycle ?? (row.live !== null && working(row.live) ? 'working' : null)

  return (
    <div className={SIDE}>
      <div className={SIDE_LINE}>
        {/* An INTERACTIVE session's name is derived by the CLI (`nixos-ac`) and
          names the session rather than the work, so it is marked as the weak
          label it is. A background agent's name is the one it was launched
          with — a real title — and marking that would be a lie. That holds
          whether or not its process is still there, so `dormant` is exempt
          for exactly the reason `background` is. */}
        {row.labelSource === 'agent' && row.state !== 'background' && row.state !== 'dormant' && (
          <span className={ROW_SIDE}>cli name</span>
        )}
        {/* A session this box started says so: it is the only live population
          with a kill, and the row is where that difference is decided. */}
        {row.managed && <span className={ROW_SIDE}>ours</span>}
        {/* Idle is the resting word; a session mid-turn is the one to see. */}
        {lifecycle !== null && (
          <span className={cn(ROW_SIDE, lifecycle !== 'idle' && 'text-foreground')}>
            {lifecycle}
          </span>
        )}
        {/* Spelled out beside the lifecycle word, because that word is what
          misleads: `blocked` is an agent waiting on a human, and reads as a
          live thing pausing. The missing pid is the fact underneath it. */}
        {row.state === 'dormant' && <span className={ROW_SIDE}>no process</span>}
        {control.kind === 'none' && control.why === 'server' && (
          <span className={ROW_SIDE}>ends with the server</span>
        )}
      </div>
    </div>
  )
}

/**
 * The ids a row goes by — the CLI's name, the id claude.ai shows (which is NOT
 * the transcript uuid), the short id — on a line of their own under the facts.
 * Each id is a single unbreakable token, so a session id never splits across
 * two lines; the line itself wraps between ids.
 */
function RowIds({ row }: { row: RosterEntry }) {
  // A row with no title falls back to its own short id for a label, and the
  // id slot then printed the same eight characters a second time. One of them
  // is enough: the slot is for the case where the NAME does not identify the
  // row, which is exactly the case where they differ.
  const idCandidate = row.shortId ?? (row.id === null ? null : row.id.slice(0, 8))
  const shownId = preview(row) === null && idCandidate === row.label ? null : (idCandidate ?? DASH)
  // The name claude.ai shows. When it IS the label there is nothing to add;
  // when a title outranks it, this is the only place it survives.
  const cliName = row.live?.name != null && row.live.name !== row.label ? row.live.name : null
  const ids = [cliName, row.live?.remote_id ?? null, shownId].filter((x) => x !== null)
  if (ids.length === 0) return null
  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.72rem] text-muted-foreground">
      {ids.map((id) => (
        <span key={id} className="whitespace-nowrap">
          {id}
        </span>
      ))}
    </div>
  )
}

/** Whether this row is titled by its first message rather than by a name: a
    transcript with no title and no agent name, which would read as a raw id. */
function preview(row: RosterEntry): string | null {
  return row.labelSource === 'id' ? promptLine(row.meta) : null
}

/* One line, grouped. Each span answers one question; the three that always
   have an answer carry an icon in place of the word they would otherwise
   need, and the rest keep their words. See lib/claude-meta.ts for why a zero
   never reaches this line. */
function RowMetaLine({ row }: { row: RosterEntry }) {
  const groups = factGroups(
    {
      cwd: row.cwd,
      cwdExact: row.cwdExact,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      meta: row.meta,
      live: row.live,
    },
    Date.now(),
  )
  if (groups.length === 0) return null
  return (
    <div className={META}>
      {groups.map((g) => (
        <span key={g.key} className={META_ITEM} title={g.detail ?? undefined}>
          {g.icon !== null && <FactIconFor name={g.icon} />}
          <span className="truncate max-[40rem]:whitespace-normal! max-[40rem]:[overflow-wrap:anywhere]">
            {g.text}
          </span>
        </span>
      ))}
    </div>
  )
}

/** What the agent last said about THIS row's verb. */
function RowOutcome({ outcome }: { outcome: ActionOutcome }) {
  if (outcome.state === 'running')
    return <p className={CTRL_STATE}>{outcome.detail || 'Working…'}</p>
  if (outcome.state === 'done') {
    return <p className={cn(CTRL_STATE, 'text-success')}>{outcome.detail || 'Done.'}</p>
  }
  return <p className={cn(CTRL_STATE, 'text-danger')}>{outcome.detail}</p>
}

/** The sentence an armed row shows: what this press costs, per verb. */
function ArmedCost({ control }: { control: ActiveControl }) {
  if (control.kind === 'resume') {
    return (
      <>
        This CONTINUES the session — same id, same transcript, appended to. It comes back as a live
        session on claude.ai, in the trusted project directory it ran in, as the machine's user and
        with sudo on its path, in a unit of its own that outlives the agent. Nothing is branched and
        nothing is overwritten.
      </>
    )
  }
  if (control.kind === 'stop-unit') {
    return (
      <>
        <span className={MONO}>systemctl --user stop</span> on this session's unit: systemd ends its
        whole process group, including anything it is running right now. The transcript survives and
        it can be resumed again from this board.
      </>
    )
  }
  if (control.kind === 'remove-agent') {
    return (
      <>
        <span className={MONO}>claude rm {control.session}</span> — the verb for a record, which is
        all this row is. Nothing is being stopped: there is no process behind it, and{' '}
        <span className={MONO}>claude stop</span> would have nothing to act on. This DELETES the
        background session and its worktree, so{' '}
        <span className={MONO}>claude attach {control.session}</span> has nothing to reopen
        afterwards — leave it alone if the conversation is still wanted.
      </>
    )
  }
  return (
    <>
      <span className={MONO}>claude stop {control.session}</span> — upstream's own verb. The agent
      stops where it is; its conversation is kept, and{' '}
      <span className={MONO}>claude attach {control.session}</span> reopens it.
    </>
  )
}
