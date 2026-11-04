import { useRouter } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { TypedConfirm } from '../../../components/armed-confirm'
import { usePolledStatus } from '../../../components/status'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, Chip } from '../../../components/viz'
import type { VersionUpdateStatus } from '../../../host/version-update'
import { cn } from '../../../lib/cn'
import { fetchVersionUpdateStatus, requestVersionUpdateFn } from '../../../server/versions'
import type { FactorioOption } from '../data/factorio'
import { CONFIRM, OPTION, OPTION_ON, VersionProgress } from './version-progress'

// Moving the server's Factorio version, from its own tab.
//
// Every move asks for the version typed before it arms, unlike Minecraft's
// same-game build bumps: each Factorio release is a new game version, so it
// turns away every client not on it, and the first load converts a save for
// good. The update itself never starts a game — ofsm idles until someone
// starts one from the manager, and that is the moment a save converts.

export function FactorioVersionBoard({
  installed,
  options,
  gameRunning,
  initialStatus,
}: {
  installed: string | null
  options: FactorioOption[]
  /** From the server's own log; null when the log could not say. */
  gameRunning: boolean | null
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

  const chosen = options.find((o) => o.version === picked) ?? options[0] ?? null
  const armed = chosen !== null && typed.trim() === chosen.version

  return (
    <Board
      title="Game version"
      icon="⚙"
      span={12}
      aside={
        <span className={NOTE}>
          running <span className={MONO}>{installed ?? '?'}</span>
        </span>
      }
    >
      {options.length === 0 ? (
        <p className={EMPTY}>nothing newer to move to: this server is on Wube's newest release</p>
      ) : (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
          <legend className="sr-only">Version to move to</legend>
          {options.map((o) => (
            <label
              key={o.version}
              className={cn(
                OPTION,
                'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary-dim',
                chosen?.version === o.version && OPTION_ON,
                running && 'cursor-not-allowed opacity-45',
              )}
            >
              <input
                type="radio"
                name={radioName}
                className="sr-only"
                checked={chosen?.version === o.version}
                disabled={running}
                onChange={() => {
                  setPicked(o.version)
                  setTyped('')
                }}
              />
              <span className={cn(MONO, 'text-[0.875rem] text-foreground')}>{o.version}</span>
              <Chip tone={o.channel === 'stable' ? 'ok' : 'warn'}>{o.channel}</Chip>
              {o.channel === 'stable' && <Chip tone="ok">recommended</Chip>}
            </label>
          ))}
        </fieldset>
      )}

      {chosen !== null && (
        <div className="flex flex-col gap-2">
          <div className={CONFIRM}>
            <p className="m-0 text-[0.8rem]">
              <strong>Clients must match.</strong> A Factorio client joins only a server on its own
              version, so anyone still on {installed ?? 'the old version'} is turned away until
              their game updates.
              {chosen.channel === 'experimental' &&
                ' Steam keeps players on stable unless each one opts into the experimental branch, so most clients will not match.'}
            </p>
            <p className="m-0 mt-1.5 text-[0.8rem]">
              <strong>One way for saves.</strong> The update does not start a game. The first time{' '}
              {chosen.version} loads a save it converts it, and {installed ?? 'the old version'}{' '}
              cannot open it afterwards.
            </p>
            <TypedConfirm
              name={chosen.version}
              value={typed}
              disabled={running}
              onChange={setTyped}
              className="mt-2.5"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              type="button"
              size="sm"
              disabled={running || !armed}
              onClick={() =>
                start(async () => {
                  const r = await requestVersionUpdateFn({
                    data: { target: 'factorio', values: { version: chosen.version } },
                  })
                  return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
                })
              }
            >
              {running ? 'Updating…' : `Update to ${chosen.version}`}
            </Button>
            <span className={NOTE}>
              {gameRunning === true
                ? 'a game is running: the restart stops it after a final save'
                : gameRunning === false
                  ? 'no game is running'
                  : 'whether a game is running is unknown'}
            </span>
          </div>
        </div>
      )}

      <VersionProgress target="factorio" status={status} running={running} refusal={refusal} />

      <p className={FOOT}>
        An update rewrites the version in the configuration, commits, rebuilds, and passes only when
        the server binary the container downloaded reports the new version and the manager answers.
      </p>
    </Board>
  )
}
