import { Link, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, since } from '../../lib/format'
import { errorText } from '../../lib/redact'
import type { Tone } from '../../lib/tone'
import { requestUpdateCheckFn } from '../../server/nodes'
import { GHOST_BTN } from '../apps/shared'
import { Button } from '../ui/button'
import { Board, BoardGrid, Chip, Facts } from '../viz'
import {
  ago,
  DetailNote,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  NotReadable,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
} from './shared'

/* ── Updates ──────────────────────────────────────────────────────────── */

function severityTone(s: string | null): Tone {
  switch (s) {
    case 'critical':
    case 'important':
      return 'bad'
    case 'moderate':
    case 'recommended':
      return 'warn'
    default:
      return 'muted'
  }
}

/**
 * The box's Updates tab, for a node: the agent's own pin, then the
 * operating system's.
 *
 * The box's page is a list of sixty container pins and a button that moves
 * one. A node has two things that update: the agent, which this box
 * releases and the machine installs on its own within ten minutes (or now,
 * from the button here — the same one Settings › Machines has, because
 * this is where you are when you notice the version); and the OS, which
 * only the person at the keyboard can move. So the OS boards report and
 * do not act: what is pending, whether a restart is owed, what went in
 * lately.
 */
export function NodeUpdatesView({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (t === null || status === null) return null
  const u = t.updates
  const pending = u?.pending ?? []

  return (
    <BoardGrid>
      <Board
        title="Agent"
        icon="◎"
        span={12}
        aside={
          status.restartPending ? (
            <Chip tone="ok">installed, restarting</Chip>
          ) : status.updateAvailable !== null ? (
            <Chip tone="warn">{status.updateAvailable}</Chip>
          ) : (
            <Chip tone="ok">current</Chip>
          )
        }
      >
        <Facts
          rows={[
            { k: 'Running', v: <span className={MONO}>{status.version}</span> },
            {
              k: 'Last check',
              v: status.lastUpdateResult ?? 'not checked yet',
            },
            { k: 'Last hello', v: since(node.lastSeenAgo) },
          ]}
        />
        <div className="mt-[0.7rem] flex flex-wrap items-center gap-2 border-(--border-soft) border-t pt-[0.75rem]">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            disabled={busy || node.updateCheckRequested}
            onClick={() => {
              setError(null)
              start(async () => {
                try {
                  await requestUpdateCheckFn({ data: { id: node.id } })
                  await router.invalidate()
                } catch (e) {
                  setError(errorText(e))
                }
              })
            }}
          >
            {node.updateCheckRequested ? 'Update queued' : 'Update now'}
          </Button>
          <span className={NOTE}>
            {node.updateCheckRequested
              ? 'rides the next hello, within a minute; the agent installs and restarts on its own'
              : 'the agent looks every ten minutes on its own; this makes it look now'}
          </span>
          {error !== null && <span className={cn(NOTE, 'text-danger')}>{error}</span>}
        </div>
        <p className={FOOT}>
          Releases are signed by this box&rsquo;s key and published from the engine&rsquo;s
          repository; the agent verifies the signature before it swaps its own binary. Which version
          is newest is what the agent reports after it looks, so &ldquo;current&rdquo; here is its
          word, not this page&rsquo;s.
        </p>
      </Board>

      <Board
        title={
          u === null
            ? 'Operating system'
            : u.error !== null && pending.length === 0
              ? 'Operating system'
              : pending.length === 0
                ? 'Nothing pending'
                : `${num(pending.length)} pending`
        }
        icon="⇣"
        span={12}
        aside={
          u === null ? undefined : u.rebootPending === true ? (
            <Chip tone="warn">restart owed</Chip>
          ) : pending.length === 0 && u.error === null ? (
            <Chip tone="ok">up to date</Chip>
          ) : undefined
        }
      >
        {!d.full ? (
          <p className={EMPTY}>On the full document.</p>
        ) : u === null ? (
          <p className={EMPTY}>
            The agent has not finished its first search yet; it asks the OS within a minute of
            starting and hourly after.
          </p>
        ) : u.error !== null && pending.length === 0 ? (
          <p className={cn(EMPTY, 'text-warning')}>The search did not answer: {u.error}</p>
        ) : pending.length === 0 ? (
          <p className={EMPTY}>
            {node.os === 'macos'
              ? 'Software Update has nothing to offer.'
              : 'Windows Update has nothing to offer.'}
          </p>
        ) : (
          <ul className={LIST}>
            {pending.map((p, i) => (
              <li key={`${p.id ?? p.title}-${String(i)}`} className={`${ROW} flex-wrap`}>
                {p.severity !== null && <Chip tone={severityTone(p.severity)}>{p.severity}</Chip>}
                <span className={ROW_MAIN}>{p.title}</span>
                <span className={ROW_SIDE}>
                  {p.id !== null && p.id !== p.title && <span className={MONO}>{p.id} · </span>}
                  {p.sizeBytes !== null && `${bytes(p.sizeBytes)} · `}
                  {p.restart === true ? 'restarts' : p.restart === false ? 'no restart' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DetailNote d={d} />
        <p className={FOOT}>
          {u !== null && u.checkedAt !== null && `Asked ${ago(u.checkedAt)}. `}
          {node.os === 'macos'
            ? 'What softwareupdate lists from the OS’s own last scan, which it runs daily. Installing is the person at the machine: the agent runs as a daemon and Apple does not let a daemon restart a Mac into an installer.'
            : 'What the Windows Update agent answers when searched for installed=0, which is the same list Settings shows. Installing stays with the person at the machine: an update that restarts the PC mid-game is not this box’s call.'}
        </p>
      </Board>

      <Board
        title="Installed lately"
        icon="✓"
        span={6}
        aside={u !== null && <span className={NOTE}>{num(u.installed.length)} newest</span>}
      >
        {!d.full || u === null ? (
          <p className={EMPTY}>{d.full ? 'not read yet' : 'on the full document'}</p>
        ) : u.installed.length === 0 ? (
          <p className={EMPTY}>Nothing on record.</p>
        ) : (
          <ul className={LIST}>
            {u.installed.map((x, i) => (
              <li key={`${x.title}-${String(i)}`} className={ROW}>
                <span className={ROW_MAIN}>{x.title}</span>
                <span className={ROW_SIDE}>{x.at === null ? DASH : ago(x.at)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className={FOOT}>
          {node.os === 'macos'
            ? 'From the install history Software Update keeps, OS updates only.'
            : 'The hotfixes Windows records, newest first — cumulative updates and servicing stack updates, not Store apps.'}
        </p>
      </Board>

      <Board
        title="Claude Code"
        icon="claude"
        span={6}
        aside={
          status.claude === null ? undefined : (
            <Chip tone={status.claude.state === 'running' ? 'ok' : 'muted'}>
              {status.claude.state}
            </Chip>
          )
        }
      >
        {status.claude === null ? (
          <p className={EMPTY}>The tray is not reporting Claude Code on this machine.</p>
        ) : (
          <Facts
            rows={[
              {
                k: 'CLI',
                v: <span className={MONO}>{status.claude.cliVersion ?? DASH}</span>,
              },
              {
                k: 'Server',
                v: <span className={MONO}>{status.claude.serverVersion ?? DASH}</span>,
              },
              { k: 'Signed in', v: status.claude.signedIn ? 'yes' : 'no' },
            ]}
          />
        )}
        <p className={FOOT}>
          The CLI updates itself on the machine; its sessions and the remote-control switch are on{' '}
          <Link to="/claude" search={{ machine: node.id }}>
            Claude
          </Link>
          .
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}
