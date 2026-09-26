// One roster row: its chip, name and side facts on the first line, the last
// prompt and the grouped metadata under it, and — where there is an honest
// one — its verb, armed in place.
import { ClockIcon, FolderGit2Icon, MessagesSquareIcon } from 'lucide-react'

// Types ONLY: the host module behind this type reads node:fs.
import type { ClaudeSessionStatus } from '../../../host/claude-session-request'
// Pure and client-safe — the whole reason the roster's types, its join and
// the row's derived facts live in lib/ rather than beside the loader. See the
// header of claude-roster.ts.
import { type FactIcon, factGroups, promptLine } from '../../../lib/claude-meta'
import { type RosterEntry, type RowControl, rowControl } from '../../../lib/claude-roster'
import { cn } from '../../../lib/cn'
import { DASH } from '../../../lib/format'
import { toneStyle } from '../../../lib/tone'
import { GHOST_BTN } from '../../apps/shared'
import { MONO, MONO_FACE, ROW, ROW_MAIN, ROW_SIDE } from '../../tokens'
import { Button } from '../../ui/button'
import { Chip } from '../../viz'
import { NARROW_HIDE, RC_ARM_MS } from '../shared'
import { working } from '../verdicts'
import { ROW_ACCENT, STATE_ACCENT, STATE_LABEL, STATE_TONE } from './tones'

/* The verb at the right edge OF the row, not under it: a button on a line of
   its own makes every row taller and a long list a ragged column. The rest of
   this page lays a row out as chip · name · facts, with anything actionable at
   the right edge, and this board reads as part of that page only if it does
   the same. `shrink-0` because the truncating side slots to its left would
   otherwise give away the button's width before their own. */
const ROW_BTN = 'ml-auto h-auto shrink-0 px-[0.55rem] py-[0.2rem] text-[0.7rem]'

/* ── the enriched row ─────────────────────────────────────────────────────

   Three lines: what it is, what was last said to it, and what is in it. The
   grouping is the design — a directory and a branch are one fact, a turn
   count and a file size are one fact, a span and an idle time are one story —
   and it lives in lib/claude-meta.ts so it can be tested without a DOM. */

/* The last prompt. One line, clipped, and in the muted ink the board uses for
   anything that is not a measurement, so it reads as context under the title
   rather than as a second title. */
const PROMPT = 'mt-[0.22rem] truncate text-[0.72rem] leading-[1.45] text-(--text-muted)'

/* The metadata line. Wraps rather than scrolls — a row here is already a
   block, and a horizontal scrollbar inside one would be the third scroll axis
   on the page. The gap is wide enough that the groups read as groups without
   a separator glyph between them. */
const META =
  'mt-[0.2rem] flex min-w-0 flex-wrap items-center gap-x-[0.7rem] gap-y-[0.1rem] text-[0.68rem] text-muted-foreground tabular-nums'
const META_ITEM = 'inline-flex min-w-0 max-w-full items-center gap-[0.28rem]'
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
const CTRL = 'mt-[0.3rem] flex flex-wrap items-center gap-2'
const CTRL_COST = 'mt-[0.3rem] text-[0.72rem] text-(--text-muted) leading-[1.5]'
const CTRL_NOTE = 'text-[0.68rem] text-muted-foreground leading-[1.5]'
const CTRL_STATE = 'mt-[0.3rem] text-[0.72rem] leading-[1.5]'

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
  armed,
  busy,
  status,
  refusal,
  onArm,
  onCancel,
  onConfirm,
}: {
  row: RosterEntry
  armed: boolean
  busy: boolean
  status: ClaudeSessionStatus
  refusal: string | null
  onArm: () => void
  onCancel: () => void
  onConfirm: (control: ActiveControl) => void
}) {
  const control = rowControl(row)
  // The board has one status file, so a row only speaks when the host is
  // speaking about IT — otherwise every row would echo the same outcome.
  const mine = control.kind !== 'none' && status.session === control.session
  const prompt = promptLine(row.meta)

  return (
    <li
      className={cn(ROW, 'flex-col items-stretch', ROW_ACCENT, STATE_ACCENT[row.state])}
      title={row.id ?? undefined}
      style={toneStyle(STATE_TONE[row.state])}
    >
      <div className="flex min-w-0 items-center gap-[0.45rem]">
        <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
        <span className={ROW_MAIN}>{row.label}</span>
        <RowSideFacts row={row} control={control} />

        {/* The verb, on the row. It is hidden while armed because Confirm and
            Cancel take its place below — two buttons for one row at once is
            the ambiguity the two-step exists to avoid. */}
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

      {/* The one line of conversation on this page, and it gets a line of its
          own because it is the only thing here that is not a measurement.
          Quiet ink and a smaller size: it is context for the title above it,
          not a heading of its own. Redacted twice — host-side before it was
          written to a 0600 file, and again by `promptLine` on the way here. */}
      {prompt !== null && (
        <p className={PROMPT} title={prompt}>
          {prompt}
        </p>
      )}

      <RowMetaLine row={row} />

      {mine && <RowOutcome status={status} refusal={refusal} />}

      {control.kind !== 'none' && !busy && armed && (
        <>
          <p className={CTRL_COST}>
            <ArmedCost control={control} />
          </p>
          <div className={CTRL}>
            <Button
              type="button"
              variant={control.kind === 'resume' ? 'default' : 'destructive'}
              size="sm"
              onClick={() => {
                onConfirm(control)
              }}
            >
              {control.kind === 'resume'
                ? 'Confirm resume'
                : control.kind === 'remove-agent'
                  ? 'Confirm remove'
                  : 'Confirm stop'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={GHOST_BTN}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <span className={CTRL_NOTE}>disarms on its own in {RC_ARM_MS / 1000}s</span>
          </div>
        </>
      )}
    </li>
  )
}

/** The first line's side slots, after the name and before the verb. */
function RowSideFacts({ row, control }: { row: RosterEntry; control: RowControl }) {
  // A row with no title falls back to its own short id for a label, and the
  // id slot then printed the same eight characters a second time, on the same
  // line. One of them is enough: the slot is for the case where the NAME does
  // not identify the row, which is exactly the case where they differ.
  const idCandidate = row.shortId ?? (row.id === null ? null : row.id.slice(0, 8))
  const shownId = idCandidate === row.label ? null : (idCandidate ?? DASH)
  // `busy` is the CLI saying it is mid-turn, which no clock can infer. The
  // fallback is "touched within the last minute" (`working`, verdicts.ts), the
  // honest reading of active for a session being driven from a phone. Only
  // ever shown for a row with a process.
  const lifecycle = row.lifecycle ?? (row.live !== null && working(row.live) ? 'working' : null)
  // The name claude.ai shows. When it IS the label there is nothing to add;
  // when a title outranks it, this is the only place it survives, and the
  // board's whole job is matching a row here to a session over there.
  const cliName = row.live?.name != null && row.live.name !== row.label ? row.live.name : null

  return (
    <>
      {/* An INTERACTIVE session's name is derived by the CLI (`nixos-ac`) and
          names the session rather than the work, so it is marked as the weak
          label it is. A background agent's name is the one it was launched
          with — a real title — and marking that would be a lie. That holds
          whether or not its process is still there, so `dormant` is exempt
          for exactly the reason `background` is. */}
      {row.labelSource === 'agent' && row.state !== 'background' && row.state !== 'dormant' && (
        <span className={cn(ROW_SIDE, NARROW_HIDE)}>cli name</span>
      )}
      {/* A session this box started says so: it is the only live population
          with a kill, and the row is where that difference is decided. */}
      {row.managed && <span className={cn(ROW_SIDE, NARROW_HIDE)}>ours</span>}
      {lifecycle !== null && <span className={ROW_SIDE}>{lifecycle}</span>}
      {/* Spelled out beside the lifecycle word, because that word is what
          misleads: `blocked` is an agent waiting on a human, and reads as a
          live thing pausing. The missing pid is the fact underneath it. */}
      {row.state === 'dormant' && <span className={ROW_SIDE}>no process</span>}
      {/* The ids stay on the top line and only there: they are what the CLI
          verbs and claude.ai go by, so they belong beside the name they label
          rather than down among the measurements on the metadata line. */}
      {cliName !== null && <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{cliName}</span>}
      {/* The id claude.ai shows, which is NOT the transcript uuid beside
          it — the thing you match a row here against a session over there
          by. */}
      {row.live?.remoteId != null && (
        <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{row.live.remoteId}</span>
      )}
      {shownId !== null && <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{shownId}</span>}
      {/* No button, and the reason in its place. A session the Remote
          Control server spawned has no per-session kill anywhere — not in
          the CLI, not in systemd — so the only honest thing here is a
          sentence. The one lever that does end it is the server restart on
          the Remote control board. */}
      {control.kind === 'none' && control.why === 'server' && (
        <span className={cn(ROW_SIDE, NARROW_HIDE)}>ends with the server</span>
      )}
    </>
  )
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
        <span
          key={g.key}
          className={cn(META_ITEM, g.secondary && NARROW_HIDE)}
          title={g.detail ?? undefined}
        >
          {g.icon !== null && <FactIconFor name={g.icon} />}
          <span className="truncate">{g.text}</span>
        </span>
      ))}
    </div>
  )
}

/** What the host last said about THIS row's verb. */
function RowOutcome({ status, refusal }: { status: ClaudeSessionStatus; refusal: string | null }) {
  return (
    <>
      {status.state === 'running' && <p className={CTRL_STATE}>{status.detail || 'Working…'}</p>}
      {status.state === 'done' && (
        <p className={cn(CTRL_STATE, 'text-success')}>{status.detail || 'Done.'}</p>
      )}
      {status.state === 'failed' && refusal === null && (
        <p className={cn(CTRL_STATE, 'text-danger')}>{status.error}</p>
      )}
      {refusal !== null && <p className={cn(CTRL_STATE, 'text-danger')}>{refusal}</p>}
    </>
  )
}

/** The sentence an armed row shows: what this press costs, per verb. */
function ArmedCost({ control }: { control: ActiveControl }) {
  if (control.kind === 'resume') {
    return (
      <>
        This CONTINUES the session — same id, same transcript, appended to. It comes back as a live
        session on claude.ai, running in the configuration checkout as the operator, with sudo
        available to it. Nothing is branched and nothing is overwritten.
      </>
    )
  }
  if (control.kind === 'stop-unit') {
    return (
      <>
        <span className={MONO}>systemctl stop</span> on this session's unit: systemd SIGTERMs its
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
