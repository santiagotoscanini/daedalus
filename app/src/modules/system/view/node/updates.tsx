import { Link } from '@tanstack/react-router'
import { Ago } from '../../../../components/ago'
import { GHOST_BTN } from '../../../../components/apps/shared'
import { NodeCommandButton } from '../../../../components/node-command'
import { Board, BoardGrid, Chip, Facts } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../../../lib/format'
import { linkWords } from '../../../../lib/node-link'
import type { Tone } from '../../../../lib/tone'
import { EMPTY, FOOT, LIST, MONO, NOTE, NotReadable, ROW, ROW_MAIN, ROW_SIDE } from './shared'

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
  return (
    <div className="mt-[0.7rem] flex flex-wrap items-center gap-2 border-subtle border-t pt-[0.75rem]">
      <NodeCommandButton
        id={node.id}
        command="check_update"
        label="Update now"
        className={GHOST_BTN}
        note="the agent looks every ten minutes on its own; this makes it look now"
      />
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
  const f = nodeUpdatesFacts({ d })
  if (f === null) return null
  const { t } = f

  return (
    <BoardGrid>
      <WindowsBoard f={f} />

      <AgentBoard f={f} />

      <Panel f={f} />

      <InstalledLatelyBoard f={f} />

      <ClaudeCodeBoard f={f} />

      <NotReadable t={t} />
    </BoardGrid>
  )
}

/** What the page's boards read. */
function nodeUpdatesFacts({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  if (t === null || status === null) return null
  const u = t.updates
  const pending = u?.pending ?? []
  const wv = windowsVersion(status.os_version)
  const lastCumulative = u?.installed.find((x) => /cumulative|security update/i.test(x.title))
  return { d, node, status, t, u, pending, wv, lastCumulative }
}

type NodeUpdatesFacts = NonNullable<ReturnType<typeof nodeUpdatesFacts>>

function WindowsBoard({ f }: { f: NodeUpdatesFacts }) {
  const { status, t, u, pending, wv, lastCumulative } = f
  return (
    <Board
      title="Windows"
      icon="▣"
      span={4}
      aside={
        u === null ? undefined : u.reboot_pending === true ? (
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
          { k: 'Edition', v: status.os_name },
          { k: 'Release', v: <span className={MONO}>{wv.release}</span> },
          {
            k: 'Build',
            v: <span className={MONO}>{wv.build ?? t.os.kernel ?? DASH}</span>,
          },
          {
            k: 'Installed',
            v: t.os.installed_at === null ? DASH : <Ago at={t.os.installed_at} />,
          },
          {
            k: 'Last patch',
            v:
              lastCumulative === undefined ? (
                DASH
              ) : lastCumulative.at === null ? (
                lastCumulative.title
              ) : (
                <Ago at={lastCumulative.at} />
              ),
          },
        ]}
      />
      <p className={FOOT}>
        The release is the yearly name Microsoft gives the build line; the build&rsquo;s last number
        moves with every monthly cumulative update, which is what &ldquo;last patch&rdquo; dates.
        Installed is when this Windows was first set up, not the PC.
      </p>
    </Board>
  )
}

function AgentBoard({ f }: { f: NodeUpdatesFacts }) {
  const { node, status } = f
  return (
    <Board
      title="Agent"
      icon="◎"
      span={8}
      aside={
        status.restart_pending ? (
          <Chip tone="ok">installed, restarting</Chip>
        ) : status.update_available !== null ? (
          <Chip tone="warn">{status.update_available}</Chip>
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
            v: status.last_update_result ?? 'not checked yet',
          },
          {
            k: 'Link',
            v: linkWords(node),
          },
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
  )
}

function Panel({ f }: { f: NodeUpdatesFacts }) {
  const { u, pending } = f
  return (
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
        u === null ? undefined : u.reboot_pending === true ? (
          <Chip tone="warn">restart owed</Chip>
        ) : pending.length === 0 && u.error === null ? (
          <Chip tone="ok">up to date</Chip>
        ) : undefined
      }
    >
      {u === null ? (
        <p className={EMPTY}>
          The agent has not finished its first search yet; it asks Windows Update within a minute of
          starting and hourly after.
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
                  {p.size_bytes !== null && `${bytes(p.size_bytes)} · `}
                  {p.restart === true ? 'restarts' : p.restart === false ? 'no restart' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className={FOOT}>
        {u !== null && u.checked_at !== null && (
          <>
            Asked <Ago at={u.checked_at} />.{' '}
          </>
        )}
        What the Windows Update agent answers when searched for what is not installed, which is the
        same list Settings shows; each KB number links to Microsoft&rsquo;s own note on what it
        changes. Installing stays with the person at the machine.
      </p>
    </Board>
  )
}

function InstalledLatelyBoard({ f }: { f: NodeUpdatesFacts }) {
  const { u } = f
  return (
    <Board
      title="Installed lately"
      icon="✓"
      span={6}
      aside={u !== null && <span className={NOTE}>{num(u.installed.length)} newest</span>}
    >
      {u === null ? (
        <p className={EMPTY}>not read yet</p>
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
                <span className={ROW_SIDE}>{x.at === null ? DASH : <Ago at={x.at} />}</span>
              </li>
            )
          })}
        </ul>
      )}
      <p className={FOOT}>
        The hotfixes Windows records, newest first — cumulative updates and servicing stack updates,
        not Store apps, which are on <b>Software</b>.
      </p>
    </Board>
  )
}

function ClaudeCodeBoard({ f }: { f: NodeUpdatesFacts }) {
  const { node, status } = f
  return (
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
              v: <span className={MONO}>{status.claude.cli_version ?? DASH}</span>,
            },
            {
              k: 'Server',
              v: <span className={MONO}>{status.claude.server_version ?? DASH}</span>,
            },
            { k: 'Signed in', v: status.claude.signed_in ? 'yes' : 'no' },
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
  )
}
