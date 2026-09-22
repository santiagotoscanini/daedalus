import { Link, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Facts, type Tone } from '../../../components/viz'
import { agentHasClaude } from '../../../lib/agent/status'
import { cn } from '../../../lib/cn'
import { bytes, duration, since } from '../../../lib/format'
import { errorText } from '../../../lib/redact'
import {
  approveNodeFn,
  forgetNodeFn,
  requestUpdateCheckFn,
  revokeNodeFn,
} from '../../../server/nodes'
import type { Machine, MachinesData } from '../data/machines'
import { BOARD_FOOT, BOARD_NOTE, MONO, VIZ_EMPTY } from './shared'

// System › Machines: the other computers on this network that run the agent.
//
// One board per machine, headed like a hardware part on Build — the OS's mark
// beside the machine's name and edition — because that is what a machine is
// on this page: a physical thing with a name, not a row. Under the head, the
// facts the agent reports; at the foot, the decision the box has made about
// it and the buttons that change it.
//
// Two kinds of machine, told apart by the chip. One that said hello has a
// node row and a state — pending until approved, approved, or revoked — and
// the buttons act on that row. One that was merely found (its status page
// answers, but no hello reached the box) has no identity the box can act on;
// the board says why and what to do.
//
// The install line is on the page rather than in a doc: a machine that is
// not here yet is one PowerShell line away, and this is where the person
// looking for it is standing.

const INSTALL = 'irm https://daedalus.toscanini.me/install.ps1 | iex'

/** The OS's mark, by the family the agent reports. */
function osMark(os: string): { src: string; invert: boolean } | null {
  switch (os) {
    case 'windows':
      return { src: '/icon-windows.svg', invert: false }
    case 'macos':
      return { src: '/icon-apple.svg', invert: true }
    case 'linux':
      return { src: '/icon-linux.svg', invert: true }
    default:
      return null
  }
}

type Verdict = { chip: string; tone: Tone }

function verdict(m: Machine): Verdict {
  const s = m.status
  switch (m.node?.state) {
    case 'pending':
      return { chip: 'wants to join', tone: 'warn' }
    case 'revoked':
      return { chip: 'revoked', tone: 'bad' }
    case 'approved':
      if (s === null) return { chip: 'not answering', tone: 'muted' }
      // Off because the box said so is a state, not a fault.
      if (!s.awakeHold && !s.policy.awakeHold) return { chip: 'may sleep', tone: 'muted' }
      if (!s.awakeHold) return { chip: 'hold OFF', tone: 'bad' }
      if (s.updateAvailable !== null || s.restartPending) return { chip: 'updating', tone: 'warn' }
      return { chip: 'held awake', tone: 'ok' }
    default:
      return { chip: 'found, not announced', tone: 'muted' }
  }
}

/** The machine's name and, under it, what it runs — the part head, for a machine. */
function Head({ m }: { m: Machine }) {
  const s = m.status
  const os = s?.os ?? m.node?.os ?? ''
  const mark = osMark(os)
  const edition = s?.osName || (os ? os.charAt(0).toUpperCase() + os.slice(1) : 'unknown OS')
  const version = s?.osVersion ?? ''
  const arch = s?.arch || m.node?.arch || ''
  return (
    <div className="flex min-h-[2.6rem] items-center gap-[0.9rem] pb-[0.35rem]">
      {mark !== null && (
        <img
          src={mark.src}
          alt=""
          width={40}
          height={40}
          className={cn('size-10 flex-none', mark.invert && 'dark:invert')}
        />
      )}
      <div className="flex min-w-0 flex-auto flex-col items-start gap-[0.2rem]">
        <strong className="text-[0.98rem] text-foreground tracking-[-0.01em] wrap-anywhere">
          {m.node?.name || s?.hostname || m.lanName || m.ip}
        </strong>
        <span className="text-[0.73rem] text-(--text-muted) leading-[1.4]">
          {edition}
          {version !== '' && ` · ${version}`}
          {arch !== '' && ` · ${arch}`}
        </span>
      </div>
    </div>
  )
}

/**
 * Claude Code on the machine, in one line: what the tray reports through the
 * status page when it answers, the last hello's summary when it does not.
 * The Claude page's picker is where the rest is.
 */
function ClaudeCell({ m }: { m: Machine }) {
  const s = m.status
  const c = s?.claude
  if (c != null) {
    const alive = c.sessions.filter((x) => x.alive).length
    const version = c.server.version ?? c.cliVersion
    return c.state === 'running' || c.state === 'starting' ? (
      <span className={BOARD_NOTE}>
        <Chip tone="ok">remote control {c.state}</Chip>
        {version !== null && <span className={`${MONO} ml-2`}>{version}</span>}
        {` · ${String(alive)} session${alive === 1 ? '' : 's'}`}
      </span>
    ) : (
      <span className={BOARD_NOTE}>
        <Chip tone={c.state === 'off' ? 'muted' : 'warn'}>{c.state}</Chip>
        {c.detail !== null && ` ${c.detail}`}
      </span>
    )
  }
  if (s !== null && !agentHasClaude(s.version)) {
    return <span className={BOARD_NOTE}>needs agent 0.4.0 (has {s.version})</span>
  }
  if (s !== null && !s.trayReporting) {
    return (
      <span className={BOARD_NOTE}>
        {s.policy.claudeRemoteControl ? 'nobody logged on — the tray is not reporting' : '—'}
      </span>
    )
  }
  const h = m.node?.claude ?? null
  if (h !== null) {
    return (
      <span className={BOARD_NOTE}>
        {h.state}
        {h.serverVersion !== null && ` ${h.serverVersion}`} · {String(h.sessions)} session
        {h.sessions === 1 ? '' : 's'} · from the last hello
      </span>
    )
  }
  return <span className={BOARD_NOTE}>—</span>
}

function Decision({ m }: { m: Machine }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const node = m.node
  const act = (fn: (opts: { data: { id: string } }) => Promise<unknown>) => {
    if (node === null) return
    setError(null)
    start(async () => {
      try {
        await fn({ data: { id: node.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  if (node === null) {
    return (
      <p className={BOARD_FOOT}>
        Its status page answers but no hello has reached the box, so there is no key to trust: the
        agent is older than 0.3.0, or it cannot find the box in DNS. It will announce itself on its
        next update; nothing to press here.
      </p>
    )
  }

  const line =
    node.state === 'pending'
      ? `Announced itself ${since(node.lastSeenAgo)} and is waiting for a decision. Approve it if this is your machine.`
      : node.state === 'approved'
        ? `Approved ${node.approvedAt !== null ? since((Date.now() - Date.parse(node.approvedAt)) / 1000) : ''}${node.approvedBy !== null ? ` by ${node.approvedBy}` : ''}; last hello ${since(node.lastSeenAgo)}.${node.updateCheckRequested ? ' An update is queued for its next hello: the agent reads the release feed and installs what it finds.' : ''}`
        : `Revoked; the box ignores its hellos. Approve to trust its key again, or forget it.`

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className={BOARD_NOTE}>{line}</p>
      <div className="flex flex-wrap items-center gap-2">
        {node.state !== 'approved' && (
          <Button size="sm" disabled={busy} onClick={() => act(approveNodeFn)}>
            Approve
          </Button>
        )}
        {node.state === 'approved' && (
          <>
            {/* Rides the next hello's answer, so within a minute. The policy —
                awake, Claude — is on Settings › Machines, beside the other
                things that save at once. */}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || node.updateCheckRequested}
              onClick={() => act(requestUpdateCheckFn)}
            >
              {node.updateCheckRequested ? 'Update queued' : 'Update now'}
            </Button>
            <Button asChild size="sm" variant="ghost">
              <Link to="/settings" search={{ tab: 'machines' }}>
                Policy
              </Link>
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(revokeNodeFn)}>
              Revoke
            </Button>
          </>
        )}
        {node.state !== 'approved' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(forgetNodeFn)}>
            Forget
          </Button>
        )}
        <span
          className={`${MONO} text-[0.7rem] text-(--dim)`}
          title="sha256 of the machine's public key, the first 16 hex digits: what the box trusts"
        >
          key {node.id}
        </span>
      </div>
      {error !== null && <p className="m-0 text-[0.78rem] text-destructive">{error}</p>}
    </div>
  )
}

function MachineBoard({ m, port }: { m: Machine; port: number }) {
  const s = m.status
  const v = verdict(m)
  const rows = [
    { k: 'Agent', v: <span className={MONO}>{s?.version ?? m.node?.agentVersion ?? '—'}</span> },
    ...(s?.cpu ? [{ k: 'Processor', v: <span className={MONO}>{s.cpu}</span> }] : []),
    ...(s?.memoryBytes != null
      ? [{ k: 'Memory', v: <span className={MONO}>{bytes(s.memoryBytes)}</span> }]
      : []),
    {
      k: 'Machine up',
      v: <span className={MONO}>{s?.osUptimeSecs == null ? '—' : duration(s.osUptimeSecs)}</span>,
    },
    { k: 'Claude', v: <ClaudeCell m={m} /> },
    {
      k: 'Updates',
      v:
        s === null ? (
          <span className={BOARD_NOTE}>—</span>
        ) : s.restartPending ? (
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
      v:
        m.ip === null ? (
          <span className={BOARD_NOTE}>—</span>
        ) : (
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
    ...(m.node?.mac != null
      ? [{ k: 'Hardware address', v: <span className={MONO}>{m.node.mac}</span> }]
      : []),
  ]
  return (
    <Board
      title={m.node?.state === 'pending' ? 'New machine' : 'Machine'}
      span={6}
      aside={<Chip tone={v.tone}>{v.chip}</Chip>}
    >
      <Head m={m} />
      <Facts rows={rows} />
      {s?.holdError != null && (
        <p className={`${BOARD_NOTE} mt-2`}>The hold failed: {s.holdError}</p>
      )}
      <Decision m={m} />
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
              : `No machine has announced itself, and none of the ${String(d.probed)} asked answered the agent's status page.`}
          </p>
        </Board>
      ) : (
        d.machines.map((m) => (
          <MachineBoard key={m.node?.id ?? m.ip ?? m.lanName ?? ''} m={m} port={d.port} />
        ))
      )}

      <Board title="How a machine joins" span={12}>
        <p className={BOARD_NOTE}>Install the agent on it, from an administrator PowerShell:</p>
        <p className={`${MONO} mt-2 select-all text-[0.8rem]`}>{INSTALL}</p>
        <p className={BOARD_FOOT}>
          The agent keeps the machine awake, shows itself in the tray, updates itself from each
          release, and announces itself to this box every minute with a key it made at install — the
          machine then appears above as "wants to join" until you approve it. The page also asks
          every device pi-hole has seen in the last week for the agent's status page on TCP{' '}
          {String(d.port)} ({String(d.probed)} asked just now
          {d.skipped > 0 && `, ${String(d.skipped)} too long silent`}), so an agent that cannot find
          the box is still seen.
        </p>
      </Board>
    </BoardGrid>
  )
}
