import { Link } from '@tanstack/react-router'

import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, since } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { requestUpdateCheckFn } from '../../server/nodes'
import { GHOST_BTN } from '../apps/shared'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
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
 * The "Update now" row: the same request Settings › Machines makes, here
 * because this is where you are when you notice the version.
 */
export function AgentUpdate({ node }: { node: NodeSystemData['node'] }) {
  const { run, busy, error } = useAction()
  return (
    <div className="mt-[0.7rem] flex flex-wrap items-center gap-2 border-(--border-soft) border-t pt-[0.75rem]">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy || node.updateCheckRequested}
        onClick={() => {
          run(() => requestUpdateCheckFn({ data: { id: node.id } }))
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
  )
}

/** "KB5062553" wherever Windows writes it → Microsoft's note on it. */
function kbLink(s: string | null): string | null {
  const m = s?.match(/KB(\d{6,8})/i)
  return m === null || m === undefined ? null : `https://support.microsoft.com/help/${m[1]}`
}

/** "25H2 (26200.9457)" → { release: "25H2", build: "26200.9457" }. */
function windowsVersion(v: string): { release: string; build: string | null } {
  const m = v.match(/^(\S+)\s*(?:\(([^)]+)\))?/)
  return m === null ? { release: v, build: null } : { release: m[1] ?? v, build: m[2] ?? null }
}

/**
 * The Windows PC's Updates tab: what Windows it is, what Windows Update
 * holds for it, what went in lately, and the agent and Claude Code beside
 * them. (nodeTabsFor also gives it to a node that is neither Windows nor a
 * Mac, which it draws with the same Windows labels.)
 *
 * A node has two kinds of thing that update: the agent, which installs its
 * own releases within ten minutes (or now, from AgentUpdate), and the OS,
 * which only the person at the keyboard can move. Windows Update is the one
 * list that matters on a PC, and it is already
 * the vendor's list of what has not been taken — with a KB number on each
 * line that Microsoft keeps a page for. So the tab reports and links, and
 * does not act: installing stays with the person at the machine, since an
 * update that restarts the PC mid-game is not this box's call.
 */
export function NodeUpdatesView({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  if (t === null || status === null) return null
  const u = t.updates
  const pending = u?.pending ?? []
  const wv = windowsVersion(status.osVersion)
  const lastCumulative = u?.installed.find((x) => /cumulative|security update/i.test(x.title))

  return (
    <BoardGrid>
      <Board
        title="Windows"
        icon="▣"
        span={4}
        aside={
          u === null ? undefined : u.rebootPending === true ? (
            <Chip tone="warn">restart owed</Chip>
          ) : pending.length === 0 && u.error === null ? (
            <Chip tone="ok">up to date</Chip>
          ) : pending.length > 0 ? (
            <Chip tone="warn">{num(pending.length)} pending</Chip>
          ) : undefined
        }
      >
        <Facts
          rows={[
            { k: 'Edition', v: status.osName },
            { k: 'Release', v: <span className={MONO}>{wv.release}</span> },
            {
              k: 'Build',
              v: <span className={MONO}>{wv.build ?? t.os.kernel ?? DASH}</span>,
            },
            {
              k: 'Installed',
              v: t.os.installedAt === null ? DASH : ago(t.os.installedAt),
            },
            {
              k: 'Last patch',
              v:
                lastCumulative === undefined
                  ? DASH
                  : lastCumulative.at === null
                    ? lastCumulative.title
                    : ago(lastCumulative.at),
            },
          ]}
        />
        <p className={FOOT}>
          The release is the yearly name Microsoft gives the build line; the build&rsquo;s last
          number moves with every monthly cumulative update, which is what &ldquo;last patch&rdquo;
          dates. Installed is when this Windows was first set up, not the PC.
        </p>
      </Board>

      <Board
        title="Agent"
        icon="◎"
        span={8}
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
        <AgentUpdate node={node} />
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
            ? 'Windows Update'
            : u.error !== null && pending.length === 0
              ? 'Windows Update'
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
            The agent has not finished its first search yet; it asks Windows Update within a minute
            of starting and hourly after.
          </p>
        ) : u.error !== null && pending.length === 0 ? (
          <p className={cn(EMPTY, 'text-warning')}>The search did not answer: {u.error}</p>
        ) : pending.length === 0 ? (
          <p className={EMPTY}>Windows Update has nothing to offer.</p>
        ) : (
          <ul className={LIST}>
            {pending.map((p, i) => {
              const link = kbLink(p.id) ?? kbLink(p.title)
              return (
                <li key={`${p.id ?? p.title}-${String(i)}`} className={`${ROW} flex-wrap`}>
                  {p.severity !== null && <Chip tone={severityTone(p.severity)}>{p.severity}</Chip>}
                  <span className={ROW_MAIN}>{p.title}</span>
                  <span className={ROW_SIDE}>
                    {p.id !== null && p.id !== p.title && (
                      <>
                        {link === null ? (
                          <span className={MONO}>{p.id}</span>
                        ) : (
                          <a href={link} target="_blank" rel="noreferrer" className={MONO}>
                            {p.id} ↗
                          </a>
                        )}
                        {' · '}
                      </>
                    )}
                    {p.sizeBytes !== null && `${bytes(p.sizeBytes)} · `}
                    {p.restart === true ? 'restarts' : p.restart === false ? 'no restart' : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        <DetailNote d={d} />
        <p className={FOOT}>
          {u !== null && u.checkedAt !== null && `Asked ${ago(u.checkedAt)}. `}
          What the Windows Update agent answers when searched for what is not installed, which is
          the same list Settings shows; each KB number links to Microsoft&rsquo;s own note on what
          it changes. Installing stays with the person at the machine.
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
            {u.installed.map((x, i) => {
              const link = kbLink(x.title)
              return (
                <li key={`${x.title}-${String(i)}`} className={ROW}>
                  <span className={ROW_MAIN}>
                    {link === null ? (
                      x.title
                    ) : (
                      <a href={link} target="_blank" rel="noreferrer">
                        {x.title} ↗
                      </a>
                    )}
                  </span>
                  <span className={ROW_SIDE}>{x.at === null ? DASH : ago(x.at)}</span>
                </li>
              )
            })}
          </ul>
        )}
        <p className={FOOT}>
          The hotfixes Windows records, newest first — cumulative updates and servicing stack
          updates, not Store apps, which are on <b>Software</b>.
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
          <Link
            to="/c/$category"
            params={{ category: 'system' }}
            search={{ tab: 'claude', machine: node.id }}
          >
            Claude
          </Link>
          .
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}
