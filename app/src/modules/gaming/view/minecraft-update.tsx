import { useRouter } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { usePolledStatus } from '../../../components/status'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Board, Chip, type Tone } from '../../../components/viz'
import type { VersionUpdateStatus } from '../../../host/version-update'
import { cn } from '../../../lib/cn'
import { fetchVersionUpdateStatus, requestVersionUpdateFn } from '../../../server/versions'
import type { MinecraftUpdate, VersionOption } from '../data/minecraft-update'

// Moving the server's game version, from its own tab.
//
// The page reads Mojang (what the clients are on), Paper (what this server
// can run, and on which channel) and the host's version-update bridge. The
// button is behind two kinds of friction, each only when it applies: a newer
// GAME converts the world one way, and a build short of STABLE is one Paper
// itself warns about. Either asks for the version typed before it arms —
// the same "make the interruption deliberate" idiom as a ceremony image.

const CHANNEL_TONE: Record<string, Tone> = {
  RECOMMENDED: 'ok',
  STABLE: 'ok',
  BETA: 'warn',
  ALPHA: 'bad',
}

const OPTION = cn(
  'flex w-full min-w-0 cursor-pointer items-center gap-[0.6rem] rounded-[8px] border px-[0.6rem] py-[0.4rem] text-left',
  'border-(--border-soft) bg-(--panel-2) hover:bg-(--raise)',
)
const OPTION_ON = 'border-primary/60 bg-(--raise)'
const CONFIRM = 'rounded-[9px] border border-warning/45 bg-warning/8 px-[0.7rem] py-[0.55rem]'

const PHASE: Record<string, string> = {
  validating: 'checking the request',
  waiting: 'waiting for another rebuild to finish',
  writing: 'rewriting the pin',
  committing: 'committing',
  building: 'building the system',
  snapshotting: 'snapshotting the world',
  switching: 'switching — the server restarts now',
  verifying: 'waiting for the server to answer on the new version',
  'rolling-back': 'rolling back the world and the commit',
  pushing: 'pushing the commit',
}

export function VersionBoard({
  version,
  build,
  latest,
  players,
  update,
  initialStatus,
}: {
  version: string | null
  build: string | null
  latest: string | null
  players: number | null
  update: MinecraftUpdate
  initialStatus: VersionUpdateStatus
}) {
  const router = useRouter()
  const [picked, setPicked] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const confirmId = useId()
  const { status, running, refusal, start } = usePolledStatus({
    initial: initialStatus,
    fetch: () => fetchVersionUpdateStatus(),
    onSettle: () => void router.invalidate(),
  })

  const key = (o: VersionOption) => `${o.version}#${o.build}`
  const chosen = update.options.find((o) => key(o) === picked) ?? update.options[0] ?? null
  const needsConfirm = chosen !== null && (chosen.preRelease || chosen.newGame)
  const armed = chosen !== null && (!needsConfirm || typed.trim() === chosen.version)
  const pf = update.paperForLatest

  return (
    <Board
      title="Game version"
      icon="⚒"
      span={12}
      aside={
        <span className={NOTE}>
          running <span className={MONO}>{version ?? '?'}</span> · Paper build{' '}
          <span className={MONO}>{build ?? '?'}</span>
        </span>
      }
    >
      {update.mojangAhead && latest !== null && (
        <Alert variant="warning" className="mb-[0.6rem]">
          <AlertTitle>
            Minecraft {latest} is out, and this server runs {version}. Players on {latest} cannot
            join.
          </AlertTitle>
          <AlertDescription>
            <p className="m-0">
              {pf.stable !== null
                ? `Paper has a stable build for ${latest} (#${pf.stable}), so the server can move now.`
                : pf.newest !== null
                  ? `Paper for ${latest} is ${pf.newest.channel.toLowerCase()} only so far (newest build #${pf.newest.build}); there is no stable build yet.`
                  : `Paper has no build for ${latest} yet.`}{' '}
              Until the server moves, pick {version} in the launcher: Installations › New
              installation › version {version}.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {update.options.length === 0 ? (
        <p className={EMPTY}>
          nothing newer to move to — Paper has no newer build of {version} and no build of a newer
          game
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[0.3rem] p-0">
          {update.options.map((o, i) => (
            <li key={key(o)}>
              <button
                type="button"
                className={cn(OPTION, chosen !== null && key(o) === key(chosen) && OPTION_ON)}
                disabled={running}
                onClick={() => {
                  setPicked(key(o))
                  setTyped('')
                }}
              >
                <span className={cn(MONO, 'text-[0.84rem] text-foreground')}>{o.version}</span>
                <span className={cn(MONO, 'text-[0.76rem] text-(--text-muted)')}>
                  build {o.build}
                </span>
                <Chip tone={CHANNEL_TONE[o.channel] ?? 'muted'}>{o.channel.toLowerCase()}</Chip>
                {o.newGame && <Chip tone="info">new game</Chip>}
                {i === 0 && !o.preRelease && <Chip tone="ok">recommended</Chip>}
                <span className={cn(NOTE, 'ml-auto')}>{o.date}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen !== null && (
        <div className="mt-[0.6rem] flex flex-col gap-[0.5rem]">
          {needsConfirm && (
            <div className={CONFIRM}>
              {chosen.newGame && (
                <p className="m-0 text-[0.78rem]">
                  <strong>One way.</strong> {chosen.version} converts the world the first time it
                  starts, and {version} cannot open it afterwards. The world's dataset is
                  snapshotted first: if the server does not come back on {chosen.version}, the
                  update rolls the world and the config back by itself. After a success that
                  snapshot is the only way back.
                </p>
              )}
              {chosen.preRelease && (
                <p className="m-0 mt-[0.3rem] text-[0.78rem]">
                  <strong>
                    Paper marks build {chosen.build} {chosen.channel.toLowerCase()}.
                  </strong>{' '}
                  Paper's own warning is that builds short of stable can corrupt worlds and break
                  plugins.
                </p>
              )}
              <label
                htmlFor={confirmId}
                className={cn(NOTE, 'mt-[0.45rem] flex items-center gap-[0.5rem]')}
              >
                Type <span className={MONO}>{chosen.version}</span> to confirm
                <Input
                  id={confirmId}
                  className="h-auto w-[8rem] rounded-[7px] px-[0.5rem] py-[0.2rem] font-mono md:text-[0.8rem]"
                  value={typed}
                  disabled={running}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-[0.6rem]">
            <Button
              type="button"
              size="sm"
              disabled={running || !armed}
              onClick={() =>
                start(async () => {
                  const r = await requestVersionUpdateFn({
                    data: {
                      target: 'minecraft',
                      values: { version: chosen.version, build: chosen.build },
                    },
                  })
                  return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
                })
              }
            >
              {running ? 'Updating…' : `Update to ${chosen.version} build ${chosen.build}`}
            </Button>
            <span className={NOTE}>
              {players !== null && players > 0
                ? `${String(players)} online now — the restart disconnects them`
                : 'nobody is online'}
            </span>
          </div>
        </div>
      )}

      <Progress status={status} running={running} refusal={refusal} />

      <p className={FOOT}>
        An update rewrites the version in <span className={MONO}>stacks/minecraft</span>, commits,
        rebuilds, and passes only when the server's own status ping answers with the new version.
        Mojang's release decides who can join; Paper's channel decides how much it has been tested.
      </p>
    </Board>
  )
}

function Progress({
  status: s,
  running,
  refusal,
}: {
  status: VersionUpdateStatus
  running: boolean
  refusal: string | null
}) {
  if (refusal !== null) return <p className={cn(NOTE, 'mt-[0.4rem] text-danger')}>{refusal}</p>
  if (s.id === null || s.target !== 'minecraft') return null
  const moved = s.moves.map((m) => `${m.field} ${m.from} → ${m.to}`).join(', ')
  if (running || s.state === 'running') {
    return (
      <p className={cn(NOTE, 'mt-[0.4rem]')}>
        {PHASE[s.phase] ?? s.phase}…{moved === '' ? '' : ` (${moved})`}
      </p>
    )
  }
  if (s.state === 'done') {
    return (
      <p className={cn(NOTE, 'mt-[0.4rem] text-success')}>
        {s.phase === 'no-change'
          ? 'already there — nothing to move'
          : `updated${moved === '' ? '' : `: ${moved}`}${s.commit === null || s.commit === '' ? '' : ` (commit ${s.commit})`}.`}
        {s.snapshot !== '' && (
          <>
            {' '}
            The way back is <span className={MONO}>{s.snapshot}</span>.
          </>
        )}
      </p>
    )
  }
  if (s.state === 'failed') {
    return (
      <Alert variant="destructive" className="mt-[0.5rem]">
        <AlertTitle>
          The update failed while {PHASE[s.phase] ?? s.phase}
          {s.rolledBack ? ', and was rolled back' : ''}.
        </AlertTitle>
        <AlertDescription>
          <pre className="m-0 max-h-[12rem] overflow-auto text-[0.72rem] whitespace-pre-wrap">
            {s.error}
          </pre>
        </AlertDescription>
      </Alert>
    )
  }
  return null
}
