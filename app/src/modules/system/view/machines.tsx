import { Board, BoardGrid, Chip, Facts, type Tone } from '../../../components/viz'
import { duration, since } from '../../../lib/format'
import type { Machine, MachinesData } from '../data/machines'
import { BOARD_FOOT, BOARD_NOTE, MONO, VIZ_EMPTY } from './shared'

// System › Machines: the other computers on this network that run the agent.
//
// One board per machine, because each is a machine and not a row — it has a
// name, a version, a hold and an uptime of its own, and will have a great
// deal more once the agent reports telemetry and takes commands. Until then
// the board is small and says exactly what the status page says, with the
// address it was read from, so a reader can open the page themselves.
//
// The install line is on the page rather than in a doc: a machine that is
// not here yet is one PowerShell line away, and this is where the person
// looking for it is standing.

const INSTALL = 'irm https://daedalus.toscanini.me/install.ps1 | iex'

function holdTone(m: Machine): Tone {
  if (!m.status.awakeHold) return 'bad'
  if (m.status.updateAvailable !== null || m.status.restartPending) return 'warn'
  return 'ok'
}

function MachineBoard({ m, port }: { m: Machine; port: number }) {
  const s = m.status
  const title = s.hostname || m.name || m.ip
  return (
    <Board
      title={title}
      span={6}
      aside={<Chip tone={holdTone(m)}>{s.awakeHold ? 'held awake' : 'hold OFF'}</Chip>}
    >
      <Facts
        rows={[
          { k: 'Agent', v: <span className={MONO}>{s.version}</span> },
          { k: 'OS', v: <span className={MONO}>{s.os || '—'}</span> },
          {
            k: 'Machine up',
            v: (
              <span className={MONO}>
                {s.osUptimeSecs === null ? '—' : duration(s.osUptimeSecs)}
              </span>
            ),
          },
          { k: 'Agent up', v: <span className={MONO}>{duration(s.uptimeSecs)}</span> },
          {
            k: 'Updates',
            v: s.restartPending ? (
              <Chip tone="warn">installed, restarting</Chip>
            ) : s.updateAvailable !== null ? (
              <Chip tone="warn">{s.updateAvailable} available</Chip>
            ) : (
              <span className={BOARD_NOTE}>
                {s.lastUpdateResult ?? 'not checked yet'}
                {s.lastUpdateCheck !== null &&
                  ` · ${since((Date.now() - Date.parse(s.lastUpdateCheck)) / 1000)}`}
              </span>
            ),
          },
          {
            k: 'Address',
            v: (
              <a
                href={`http://${m.ip}:${String(port)}/status`}
                target="_blank"
                rel="noreferrer"
                className={MONO}
              >
                {m.ip}:{port}
              </a>
            ),
          },
        ]}
      />
      {s.holdError !== null && (
        <p className={`${BOARD_NOTE} mt-2`}>The hold failed: {s.holdError}</p>
      )}
      <p className={BOARD_FOOT}>
        {m.name !== null && m.name !== s.hostname ? `${m.name} on the LAN · ` : ''}
        {s.bootedAt !== null ? `booted ${s.bootedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}
        {m.lastSeenAgo !== null && ` · resolved a name ${since(m.lastSeenAgo)}`}
      </p>
    </Board>
  )
}

export function MachinesView({ d }: { d: MachinesData }) {
  return (
    <BoardGrid>
      {d.machines.length === 0 ? (
        <Board title="Machines" span={12}>
          <p className={VIZ_EMPTY}>
            {d.error !== null
              ? `The LAN device list could not be read: ${d.error}`
              : `No machine on the LAN answered the agent's status page (${String(d.probed)} asked).`}
          </p>
        </Board>
      ) : (
        d.machines.map((m) => <MachineBoard key={m.mac} m={m} port={d.port} />)
      )}

      <Board title="How a machine joins" span={12}>
        <p className={BOARD_NOTE}>Install the agent on it, from an administrator PowerShell:</p>
        <p className={`${MONO} mt-2 select-all text-[0.8rem]`}>{INSTALL}</p>
        <p className={BOARD_FOOT}>
          The agent keeps the machine awake, shows itself in the tray and updates itself from each
          release. This page finds it by asking every device pi-hole has seen in the last week for
          the page it answers on TCP {String(d.port)} — {String(d.probed)} asked just now
          {d.skipped > 0 && `, ${String(d.skipped)} too long silent to ask`}. Discovery only: a
          machine listed here is one the box can see, not yet one it can act on; the signed hello
          and the approval that make it a node come next.
        </p>
      </Board>
    </BoardGrid>
  )
}
