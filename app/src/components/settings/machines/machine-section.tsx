import { MonitorSmartphoneIcon } from 'lucide-react'

import type { LinkStatus, TunnelStatus } from '../../../host/controller/generated'
import { cn } from '../../../lib/cn'
import type { Machine } from '../../../lib/dashboard/machines'
import { bytes, duration, since } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import { Ago } from '../../ago'
import { Chip } from '../../viz'
import { NOTE_SHOWN } from '../form'
import { ASIDE, ERROR_NOTE, Line, Mono, Section } from '../shared'
import { Decision } from './decision'
import { Policy } from './policy'

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

/**
 * What a decision saved while the controller cannot take it waits for: the app
 * hands over the whole set again whenever it reconnects.
 */
export const BACK = 'Changes made here apply when the controller is back.'

type Verdict = { chip: string; tone: Tone }

/**
 * What the machine's updater is doing beyond the verdict: a version on
 * probation (its `.old` binaries kept until it proves itself), or the last
 * one it rolled back from, which it never installs again.
 */
function updateBadges(s: Machine['status']): { chip: string; tone: Tone; title: string }[] {
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

function verdict(m: Machine): Verdict {
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
 * Claude Code on the machine, in one line: the status document's summary
 * while connected, the controller's last summary otherwise. The Claude
 * page's picker is where the rest is.
 */
function ClaudeCell({ m }: { m: Machine }) {
  const s = m.status
  const c = s?.claude ?? m.node?.claude ?? null
  if (c !== null) {
    const version = c.server_version ?? c.cli_version
    return c.state === 'running' || c.state === 'starting' ? (
      <Line>
        <Chip tone="ok">remote control {c.state}</Chip>
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
function TunnelCell({ t }: { t: TunnelStatus }) {
  const up =
    t.error === null && t.last_handshake_secs !== null && t.last_handshake_secs < TUNNEL_STALE_SECS
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Line>
        <Chip tone={up ? 'ok' : 'warn'}>{up ? 'up' : 'down'}</Chip>
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
function TrustNote({ link }: { link: LinkStatus | null }) {
  if (link === null || link.error === null || link.state !== 'key-changed') return null
  return <p className={ERROR_NOTE}>{link.error}</p>
}

/** One decided machine: the head, the facts, the decision, and — once approved — the policy. */
export function MachineSection({
  m,
  lanDomain,
  askSantree,
}: {
  m: Machine
  lanDomain: string
  /** The page was opened to turn santree on for this machine. */
  askSantree: boolean
}) {
  const n = m.node
  if (n === null) return null
  const s = m.status
  const mark = osMark(n.os)
  const edition = s?.os_name || (n.os ? n.os.charAt(0).toUpperCase() + n.os.slice(1) : 'unknown OS')
  const version = s?.os_version ?? ''
  const arch = s?.arch || n.arch
  const v = verdict(m)

  const facts = [
    { k: 'Agent', v: <Mono>{s?.version ?? n.agentVersion}</Mono> },
    ...(s?.cpu ? [{ k: 'Processor', v: <Mono>{s.cpu}</Mono> }] : []),
    ...(s?.memory_bytes != null ? [{ k: 'Memory', v: <Mono>{bytes(s.memory_bytes)}</Mono> }] : []),
    {
      k: 'Machine up',
      v: <Mono>{s?.os_uptime_secs == null ? '—' : duration(s.os_uptime_secs)}</Mono>,
    },
    { k: 'Claude', v: <ClaudeCell m={m} /> },
    {
      k: 'Updates',
      v:
        s === null ? (
          <span className={ASIDE}>—</span>
        ) : s.restart_pending ? (
          <Chip tone="warn">installed, restarting</Chip>
        ) : s.update_available !== null ? (
          <Chip tone="warn">{s.update_available} available</Chip>
        ) : (
          <span className={ASIDE}>
            {s.last_update_result ?? 'not checked yet'}
            {s.last_update_check !== null && (
              <>
                {' · '}
                <Ago at={s.last_update_check} />
              </>
            )}
          </span>
        ),
    },
    {
      k: 'Address',
      v: n.lanIp === null ? <span className={ASIDE}>—</span> : <Mono>{n.lanIp}</Mono>,
    },
    ...(n.mac !== null ? [{ k: 'Hardware address', v: <Mono>{n.mac}</Mono> }] : []),
    ...(s?.controller?.tunnel != null
      ? [{ k: 'Tunnel', v: <TunnelCell t={s.controller.tunnel} /> }]
      : []),
    ...(s?.controller != null
      ? [{ k: 'Its key', v: <Mono>{s.controller.fingerprint}</Mono> }]
      : []),
    ...(s?.controller?.rotated != null
      ? [{ k: 'Controller key', v: <span className={ASIDE}>{s.controller.rotated}</span> }]
      : []),
  ]

  return (
    <Section
      title={n.name}
      icon={
        mark === null ? (
          <MonitorSmartphoneIcon />
        ) : (
          <img
            src={mark.src}
            alt=""
            width={20}
            height={20}
            className={cn('size-5 flex-none object-contain', mark.invert && 'dark:invert')}
          />
        )
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Chip tone={v.tone}>{v.chip}</Chip>
          {updateBadges(s).map((b) => (
            <span key={b.chip} title={b.title}>
              <Chip tone={b.tone}>{b.chip}</Chip>
            </span>
          ))}
          <span>
            {edition}
            {version !== '' && ` · ${version}`}
            {arch !== '' && ` · ${arch}`}
          </span>
        </span>
      }
      rows={facts}
    >
      {s?.hold_error != null && <p className={ERROR_NOTE}>The hold failed: {s.hold_error}</p>}
      <TrustNote link={s?.controller ?? null} />
      <Decision m={m} />
      {n.state === 'approved' && (
        <Policy
          n={n}
          shape={m.shape}
          lanDomain={lanDomain}
          os={edition}
          agentVersion={s?.version ?? n.agentVersion}
          askSantree={askSantree}
        />
      )}
    </Section>
  )
}

/** A key waiting at the controller: what it says it is, and the two fingerprints to compare. */
export function PendingSection({
  m,
  controllerFingerprint,
}: {
  m: Machine
  controllerFingerprint: string | null
}) {
  const p = m.pending
  if (p === null) return null
  const mark = osMark(p.os ?? '')
  return (
    <Section
      title={p.hostname ?? p.id}
      icon={
        mark === null ? (
          <MonitorSmartphoneIcon />
        ) : (
          <img
            src={mark.src}
            alt=""
            width={20}
            height={20}
            className={cn('size-5 flex-none object-contain', mark.invert && 'dark:invert')}
          />
        )
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Chip tone="warn">wants to join</Chip>
          <span>
            {p.os ?? 'unknown OS'}
            {p.arch !== null && ` · ${p.arch}`}
            {p.agent_version !== null && ` · agent ${p.agent_version}`}
          </span>
        </span>
      }
      rows={[
        { k: 'Its key', v: <Mono>{p.fingerprint}</Mono> },
        {
          k: 'Controller key',
          v:
            controllerFingerprint === null ? (
              <span className={ASIDE}>the controller did not say</span>
            ) : (
              <Mono>{controllerFingerprint}</Mono>
            ),
        },
        {
          k: 'Address',
          v: p.lan_ip === null ? <span className={ASIDE}>—</span> : <Mono>{p.lan_ip}</Mono>,
        },
      ]}
    >
      <p className={NOTE_SHOWN}>
        The machine's tray and status page show both keys. Approve only if they match what it shows:
        its own, and the controller's it trusts.
      </p>
      <Decision m={m} />
    </Section>
  )
}
