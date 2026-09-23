import { Link } from '@tanstack/react-router'
import type { MacRelease } from '../../lib/dashboard/macos-releases'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { Board, BoardGrid, Chip, Facts, Measures } from '../viz'
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

/* ── macOS ────────────────────────────────────────────────────────────── */

/**
 * The Mac's own tab: what macOS it runs, and what Apple has shipped since.
 *
 * A Mac has no BIOS list and no Windows Update; it has one number, and
 * Apple moves everything — the firmware, the kernel, Safari — by moving
 * it. So the tab answers the one question in Apple's own words: the
 * version running, the point releases of its line it has not taken, each
 * with its date, its build, what Apple fixed (the release notes) and what
 * it closed (the security content), and the next major waiting past them.
 * Beside that, what Software Update on the machine is actually offering,
 * which is the same thing from the other end.
 *
 * Nothing here installs anything: the agent is a daemon and Apple does
 * not let a daemon restart a Mac into an installer.
 */
export function NodeMacosView({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  const m = d.macos
  if (t === null || status === null) return null
  const u = t.updates
  const pending = u?.pending ?? []
  const newest = m?.line[0] ?? null
  const behind = m?.line.length ?? 0
  const verdict: { tone: Tone; label: string } =
    m === null || m.error !== null
      ? { tone: 'muted', label: 'not checked' }
      : behind === 0 && m.next === null
        ? { tone: 'ok', label: 'newest' }
        : behind === 0
          ? { tone: 'info', label: `${m.next?.name ?? 'next major'} is out` }
          : { tone: behind >= 3 ? 'bad' : 'warn', label: `${num(behind)} behind` }
  // The history also holds XProtect and Safari; the OS's own line is what dates the Mac.
  const lastInstalled = u?.installed.find((x) => /^macOS/i.test(x.title)) ?? null

  return (
    <BoardGrid>
      <Board
        title="This Mac runs"
        icon="⌘"
        span={4}
        aside={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
      >
        <Facts
          rows={[
            {
              k: 'macOS',
              v: (
                <>
                  {m?.running.name !== null && m?.running.name !== undefined
                    ? `${m.running.name} `
                    : ''}
                  <span className={MONO}>{m?.running.version ?? status.osVersion}</span>
                </>
              ),
            },
            {
              k: 'Build',
              v: <span className={MONO}>{m?.running.build ?? t.os.build ?? DASH}</span>,
            },
            {
              k: 'Darwin',
              v: t.os.kernel === null ? DASH : <span className={MONO}>{t.os.kernel}</span>,
            },
            {
              k: 'Firmware',
              v:
                t.machine.biosVersion === null ? (
                  DASH
                ) : (
                  <span className={MONO}>{t.machine.biosVersion}</span>
                ),
            },
            {
              k: 'Installed',
              v: t.os.installedAt === null ? DASH : ago(t.os.installedAt),
            },
            {
              k: 'Last update',
              v:
                lastInstalled === null
                  ? DASH
                  : lastInstalled.at === null
                    ? lastInstalled.title
                    : `${lastInstalled.title.replace(/^macOS\s+/, '')} · ${ago(lastInstalled.at)}`,
            },
          ]}
        />
        <p className={FOOT}>
          The firmware is iBoot&rsquo;s, and it moves with macOS: a pending system update below is a
          pending firmware update too. Installed is when this macOS was first set up on the machine.
        </p>
      </Board>

      <Board
        title="Apple ships"
        icon="⇣"
        span={8}
        aside={
          m?.checkedAt !== undefined && m !== null ? (
            <span className={NOTE}>read {ago(m.checkedAt)}</span>
          ) : undefined
        }
      >
        <Measures
          items={[
            { k: 'newest in line', v: newest?.version ?? (m === null ? DASH : m.running.version) },
            {
              k: 'published',
              v: newest?.date === null || newest === null ? DASH : ago(newest.date),
            },
            { k: 'behind', v: m === null ? DASH : num(behind) },
            {
              k: 'next major',
              v: m?.next === null || m === null ? DASH : `${m.next.name} ${m.next.version}`,
            },
          ]}
        />
        <p className={FOOT}>
          {m === null ? (
            <>
              Apple&rsquo;s list was not read for this page. Open the tab again from{' '}
              <Link
                to="/c/$category"
                params={{ category: 'system' }}
                search={{ tab: 'macos', machine: node.id }}
              >
                macOS
              </Link>
              .
            </>
          ) : m.error !== null ? (
            <>{m.error}</>
          ) : (
            <>
              From Apple&rsquo;s own release table, which lists every macOS by name and date, its
              version feed for the builds, and its developer release notes for what changed.{' '}
              {behind > 0 && (
                <>
                  Being {num(behind)} behind in the {m.running.name ?? 'running'} line is a fact,
                  not a verdict: a point release is mostly fixes, and each one below says which.{' '}
                </>
              )}
              {m.next !== null && (
                <>
                  macOS {m.next.name} {m.next.version} is the next major; Apple keeps patching the
                  previous line for two years, so staying on {m.running.name ?? 'this one'} is a
                  choice, not a lapse.
                </>
              )}
            </>
          )}
        </p>
      </Board>

      <Board
        title={
          m === null || m.error !== null
            ? 'Since this version'
            : behind === 0 && m.next === null
              ? 'Nothing newer'
              : `${num(behind + (m.next === null ? 0 : 1))} newer`
        }
        icon="⎌"
        span={12}
        aside={
          m === null ? undefined : (
            <span className={`${NOTE} ${MONO}`}>{m.source.replace(/^https?:\/\//, '')}</span>
          )
        }
      >
        {m === null || m.error !== null ? (
          <p className={EMPTY}>{m?.error ?? 'Not read.'}</p>
        ) : behind === 0 && m.next === null ? (
          <p className={EMPTY}>
            {m.running.version} is the newest macOS Apple has published; nothing waits.
          </p>
        ) : (
          <ul className={LIST}>
            {[...(m.next === null ? [] : [m.next]), ...m.line].map((r) => (
              <ReleaseRow key={r.version} r={r} major={r === m.next} />
            ))}
          </ul>
        )}
        <p className={FOOT}>
          Newest first. The notes are Apple&rsquo;s developer release notes for the version&rsquo;s
          line — a point release shares them with its minor, and the fixes it adds on its own are
          usually in its security content, which counts the vulnerabilities it closes. Each row
          links to both.
        </p>
      </Board>

      <Board
        title={
          u === null
            ? 'Software Update offers'
            : pending.length === 0
              ? 'Software Update offers nothing'
              : `Software Update offers ${num(pending.length)}`
        }
        icon="◎"
        span={6}
        aside={
          u === null ? undefined : u.rebootPending === true ? (
            <Chip tone="warn">restart owed</Chip>
          ) : pending.length === 0 && u.error === null ? (
            <Chip tone="ok">nothing pending</Chip>
          ) : undefined
        }
      >
        {!d.full ? (
          <p className={EMPTY}>On the full document.</p>
        ) : u === null ? (
          <p className={EMPTY}>
            The agent has not finished its first search yet; it asks within a minute of starting and
            hourly after.
          </p>
        ) : u.error !== null && pending.length === 0 ? (
          <p className={`${EMPTY} text-warning`}>The search did not answer: {u.error}</p>
        ) : pending.length === 0 ? (
          <p className={EMPTY}>
            Software Update has nothing for this Mac
            {behind > 0 ? ', which means its own scan is behind Apple’s table' : ''}.
          </p>
        ) : (
          <ul className={LIST}>
            {pending.map((p, i) => (
              <li key={`${p.id ?? p.title}-${String(i)}`} className={`${ROW} flex-wrap`}>
                {p.severity !== null && <Chip tone="warn">{p.severity}</Chip>}
                <span className={ROW_MAIN}>{p.title}</span>
                <span className={ROW_SIDE}>
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
          What <span className={MONO}>softwareupdate</span> lists from the Mac&rsquo;s own last
          scan, which it runs daily: the same list System Settings shows, from the other end of
          Apple&rsquo;s table. Installing is the person at the machine.
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
          From the install history Software Update keeps, OS updates only, newest first.
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}

const SHOW_SECTIONS = 6
const SHOW_ITEMS = 2

function ReleaseRow({ r, major }: { r: MacRelease; major: boolean }) {
  const sections = r.notes.slice(0, SHOW_SECTIONS)
  const more = r.notes.length - sections.length
  return (
    <li className={`${ROW} flex-wrap`}>
      <span className={`${ROW_MAIN} flex min-w-0 flex-col gap-[0.2rem] whitespace-normal`}>
        <span className="flex flex-wrap items-center gap-2">
          <span>
            macOS {r.name} <span className={MONO}>{r.version}</span>
          </span>
          {major && <Chip tone="info">next major</Chip>}
          {!major && <Chip tone="warn">newer</Chip>}
          {r.build !== null && <span className={`${NOTE} ${MONO}`}>{r.build}</span>}
          <span className={NOTE}>{r.date === null ? DASH : ago(r.date)}</span>
          {r.cves !== null && r.cves > 0 && (
            <Chip tone={r.cves >= 20 ? 'bad' : 'warn'}>
              {num(r.cves)} {r.cves === 1 ? 'CVE' : 'CVEs'}
            </Chip>
          )}
          {r.cves === 0 && <Chip tone="muted">no CVEs</Chip>}
        </span>
        {sections.length === 0 ? (
          <span className={NOTE}>
            {r.securityNote ?? 'Apple published no developer notes for this version'}
          </span>
        ) : (
          <span className="flex flex-col gap-[0.1rem] text-[0.8rem] text-foreground leading-[1.45]">
            {sections.map((s) => (
              <span key={`${s.area}/${s.kind}`}>
                <span className="text-(--text-muted)">
                  {s.area}
                  {s.kind !== 'Notes' && ` · ${s.kind.toLowerCase()}`}:
                </span>{' '}
                {s.items.slice(0, SHOW_ITEMS).join(' ')}
                {s.items.length > SHOW_ITEMS && (
                  <span className={NOTE}> +{num(s.items.length - SHOW_ITEMS)}</span>
                )}
              </span>
            ))}
            {more > 0 && (
              <span className={NOTE}>
                and {num(more)} more {more === 1 ? 'area' : 'areas'} in the full notes
              </span>
            )}
          </span>
        )}
      </span>
      <span className={`${ROW_SIDE} flex flex-col items-end gap-[0.15rem]`}>
        {r.notesUrl !== null && (
          <a href={r.notesUrl} target="_blank" rel="noreferrer">
            release notes ↗
          </a>
        )}
        {r.securityUrl !== null && (
          <a href={r.securityUrl} target="_blank" rel="noreferrer">
            security content ↗
          </a>
        )}
      </span>
    </li>
  )
}
