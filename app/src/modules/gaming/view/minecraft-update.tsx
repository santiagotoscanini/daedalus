import { useRouter } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { TypedConfirm } from '../../../components/armed-confirm'
import { RebootRequired } from '../../../components/reboot-required'
import { usePolledStatus } from '../../../components/status'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import { Board, Chip, type Tone } from '../../../components/viz'
import type { VersionUpdateStatus } from '../../../host/version-update'
import { cn } from '../../../lib/cn'
import { REBOOT_REQUIRED } from '../../../lib/reboot-required'
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
  'flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
  'border-hairline bg-foreground/[0.03] hover:bg-foreground/[0.05]',
)
const OPTION_ON = 'border-primary/60 bg-foreground/[0.075] hover:bg-foreground/[0.075]'
const CONFIRM = 'rounded-xl border border-warning/30 bg-warning/[0.07] px-3.5 py-3'

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
  const radioName = useId()
  const [picked, setPicked] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
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
        <Alert variant="warning">
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
        // One choice out of several: real radios, each option a label that
        // carries chips and a date a segmented control has no room for.
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="sr-only">Version to move to</legend>
          {update.options.map((o, i) => (
            <label
              key={key(o)}
              className={cn(
                OPTION,
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary-dim',
                chosen !== null && key(o) === key(chosen) && OPTION_ON,
                running && 'cursor-not-allowed opacity-45',
              )}
            >
              <input
                type="radio"
                name={radioName}
                className="sr-only"
                checked={chosen !== null && key(o) === key(chosen)}
                disabled={running}
                onChange={() => {
                  setPicked(key(o))
                  setTyped('')
                }}
              />
              <span className={cn(MONO, 'text-[0.875rem] text-foreground')}>{o.version}</span>
              <span className={cn(MONO, 'text-[0.75rem] text-subdued')}>build {o.build}</span>
              <Chip tone={CHANNEL_TONE[o.channel] ?? 'muted'}>{o.channel.toLowerCase()}</Chip>
              {o.newGame && <Chip tone="info">new game</Chip>}
              {i === 0 && !o.preRelease && <Chip tone="ok">recommended</Chip>}
              <span className={cn(NOTE, 'ml-auto')}>{o.date}</span>
            </label>
          ))}
        </fieldset>
      )}

      {chosen !== null && (
        <div className="flex flex-col gap-2">
          {needsConfirm && (
            <div className={CONFIRM}>
              {chosen.newGame && (
                <p className="m-0 text-[0.8rem]">
                  <strong>One way.</strong> {chosen.version} converts the world the first time it
                  starts, and {version} cannot open it afterwards. The world's dataset is
                  snapshotted first: if the server does not come back on {chosen.version}, the
                  update rolls the world and the config back by itself. After a success that
                  snapshot is the only way back.
                </p>
              )}
              {chosen.preRelease && (
                <p className="m-0 mt-1.5 text-[0.8rem]">
                  <strong>
                    Paper marks build {chosen.build} {chosen.channel.toLowerCase()}.
                  </strong>{' '}
                  Paper's own warning is that builds short of stable can corrupt worlds and break
                  plugins.
                </p>
              )}
              <TypedConfirm
                name={chosen.version}
                value={typed}
                disabled={running}
                onChange={setTyped}
                className="mt-2.5"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2.5">
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
  if (refusal !== null) return <p className={cn(NOTE, 'm-0 text-danger')}>{refusal}</p>
  if (s.id === null || s.target !== 'minecraft') return null
  const moved = s.moves.map((m) => `${m.field} ${m.from} → ${m.to}`).join(', ')
  if (running || s.state === 'running') {
    return (
      <p className={cn(NOTE, 'm-0')}>
        {PHASE[s.phase] ?? s.phase}…{moved === '' ? '' : ` (${moved})`}
      </p>
    )
  }
  if (s.state === 'done' && s.phase === REBOOT_REQUIRED) {
    return (
      <div>
        <RebootRequired note={s.error} />
      </div>
    )
  }
  if (s.state === 'done') {
    return (
      <p className={cn(NOTE, 'm-0 text-success')}>
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
      <Alert variant="destructive">
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
