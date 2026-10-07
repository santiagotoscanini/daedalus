import type { LinkStatus, TunnelStatus } from '../../../host/controller/generated'
import { cn } from '../../../lib/cn'
import type { Machine } from '../../../lib/dashboard/machines'
import { bytes, since } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import { Chip } from '../../viz'
import { ASIDE, ERROR_NOTE, Line, Mono } from '../shared'

// The cells a machine's row and its open panel are drawn from: the OS mark,
// the one-word verdict, the updater's badges, Claude's line and the tunnel's.

/**
 * What a decision saved while the controller cannot take it waits for: the app
 * hands over the whole set again whenever it reconnects.
 */
export const BACK = 'Changes made here apply when the controller is back.'

/** The OS's mark, by the family the agent reports — identity, drawn small. */
export function OsMark({ os }: { os: string }) {
  const mark =
    os === 'windows'
      ? { src: '/icon-windows.svg', invert: false }
      : os === 'macos'
        ? { src: '/icon-apple.svg', invert: true }
        : os === 'linux'
          ? { src: '/icon-linux.svg', invert: true }
          : null
  if (mark === null) return <span aria-hidden="true" className="size-4 flex-none" />
  return (
    <img
      src={mark.src}
      alt=""
      width={16}
      height={16}
      className={cn('size-4 flex-none object-contain', mark.invert && 'dark:invert')}
    />
  )
}

/** The OS family as its maker writes it: macOS, not Macos. */
export function osName(os: string | null | undefined): string {
  if (os === 'macos') return 'macOS'
  if (os === 'windows') return 'Windows'
  if (os === 'linux') return 'Linux'
  return os ? os.charAt(0).toUpperCase() + os.slice(1) : 'unknown OS'
}

export type Verdict = { chip: string; tone: Tone }

/**
 * What the machine's updater is doing beyond the verdict: a version on
 * probation (its `.old` binaries kept until it proves itself), or the last
 * one it rolled back from, which it never installs again.
 */
export function updateBadges(s: Machine['status']): { chip: string; tone: Tone; title: string }[] {
  if (s === null) return []
  const out: { chip: string; tone: Tone; title: string }[] = []
  if (s.probation !== null) {
    out.push({
      chip: 'updating (on probation)',
      tone: 'warn',
      title: `${s.probation.version} replaced ${s.probation.from}; started ${String(s.probation.starts)} time${s.probation.starts === 1 ? '' : 's'} since, and kept on probation until it proves itself`,
    })
  }
  if (s.rolled_back !== null) {
    out.push({
      chip: `rolled back from ${s.rolled_back.version}`,
      tone: 'bad',
      title: `${s.rolled_back.version} started ${String(s.rolled_back.starts)} times without lasting; ${s.rolled_back.to} was put back at ${s.rolled_back.at}`,
    })
  }
  return out
}

export function verdict(m: Machine): Verdict {
  const n = m.node
  if (n === null) return { chip: 'wants to join', tone: 'warn' }
  if (n.state === 'revoked') return { chip: 'revoked', tone: 'bad' }
  const s = m.status
  // The controller could not be asked: say so, not that the machine is away.
  if (n.connected === null) return { chip: 'link unknown', tone: 'muted' }
  if (!n.connected) return { chip: 'not connected', tone: 'muted' }
  if (s === null) return { chip: 'connected', tone: 'muted' }
  // Off because the box said so is a state, not a fault.
  if (!s.awake_hold && !s.policy.awake_hold) return { chip: 'may sleep', tone: 'muted' }
  if (!s.awake_hold) return { chip: 'hold OFF', tone: 'bad' }
  if (s.update_available !== null || s.restart_pending) return { chip: 'updating', tone: 'warn' }
  return { chip: 'held awake', tone: 'ok' }
}

/**
 * The verdict and the updater's badges, as a status cell: the usual answers
 * (held awake, may sleep, not connected) are said quietly; only a state that
 * needs a look wears a chip.
 */
export function StatusCell({ m }: { m: Machine }) {
  const v = verdict(m)
  // Not connected is the one quiet verdict that still wants a look: a dot, not a chip.
  const away = m.node !== null && m.node.state !== 'revoked' && m.node.connected === false
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {away ? (
        <span className="inline-flex items-center gap-1.5 text-[0.78rem] text-subdued">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
          {v.chip}
        </span>
      ) : v.tone === 'ok' || v.tone === 'muted' ? (
        <span className="text-[0.78rem] text-muted-foreground">{v.chip}</span>
      ) : (
        <Chip tone={v.tone}>{v.chip}</Chip>
      )}
      {updateBadges(m.status).map((b) => (
        <span key={b.chip} title={b.title}>
          <Chip tone={b.tone}>{b.chip}</Chip>
        </span>
      ))}
    </span>
  )
}

/**
 * Claude Code on the machine, in one line: the status document's summary
 * while connected, the controller's last summary otherwise. The Claude
 * page's picker is where the rest is.
 */
export function ClaudeCell({ m }: { m: Machine }) {
  const s = m.status
  const c = s?.claude ?? m.node?.claude ?? null
  if (c !== null) {
    const version = c.server_version ?? c.cli_version
    return c.state === 'running' || c.state === 'starting' ? (
      <Line>
        <span className="text-subdued">remote control {c.state}</span>
        {version !== null && <Mono>{version}</Mono>}
        <span className={ASIDE}>
          {String(c.sessions)} session{c.sessions === 1 ? '' : 's'}
        </span>
      </Line>
    ) : (
      <Line>
        <Chip tone={c.state === 'off' ? 'muted' : 'warn'}>{c.state}</Chip>
        {c.detail !== null && <span className={ASIDE}>{c.detail}</span>}
      </Line>
    )
  }
  if (s !== null && !s.tray.reporting) {
    return (
      <span className={ASIDE}>
        {s.policy.claude_remote_control ? 'nobody logged on — the session is not reporting' : '—'}
      </span>
    )
  }
  return <span className={ASIDE}>—</span>
}

/** How long a tunnel goes without a handshake before it reads as down (WireGuard rekeys every 2 min). */
const TUNNEL_STALE_SECS = 180

/**
 * A logged-in machine's own tunnel, as the machine reports it: up while its
 * handshakes are fresh, and why not when they are not.
 */
export function TunnelCell({ t }: { t: TunnelStatus }) {
  const up =
    t.error === null && t.last_handshake_secs !== null && t.last_handshake_secs < TUNNEL_STALE_SECS
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Line>
        {up ? <span className="text-subdued">up</span> : <Chip tone="warn">down</Chip>}
        {t.address !== '' && <Mono>{t.address}</Mono>}
        <span className={ASIDE}>
          {t.last_handshake_secs === null
            ? 'no handshake yet'
            : `handshake ${since(t.last_handshake_secs)}`}
          {` · ${bytes(t.rx_bytes)} in · ${bytes(t.tx_bytes)} out`}
        </span>
      </Line>
      {t.endpoint !== '' && <span className={ASIDE}>through {t.endpoint}</span>}
      {t.error !== null && <span className="text-[0.78rem] text-destructive">{t.error}</span>}
    </span>
  )
}

/**
 * The machine's side of the link, when it refuses the controller: the key it
 * met is not the one its install line pinned.
 */
export function TrustNote({ link }: { link: LinkStatus | null }) {
  if (link === null || link.error === null || link.state !== 'key-changed') return null
  return <p className={ERROR_NOTE}>{link.error}</p>
}
