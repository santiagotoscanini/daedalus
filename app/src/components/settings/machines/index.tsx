import { useSearch } from '@tanstack/react-router'
import { MonitorSmartphoneIcon, NetworkIcon } from 'lucide-react'

import type { AgentLink, AgentTunnel } from '../../../lib/agent/status'
import { cn } from '../../../lib/cn'
import type { Machine, MachinesData } from '../../../lib/dashboard/machines'
import { bytes, duration, since } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import { Ago } from '../../ago'
import { Chip } from '../../viz'
import { BoxProvider, GatewaySync } from '../provider-models'
import { ASIDE, ERROR_NOTE, Line, Mono, NOTE, Rows, Section } from '../shared'
import { Decision } from './decision'
import { Install } from './install'
import { Policy } from './policy'
import { RotateKey, RotationState } from './rotate'
import { SessionHost } from './session-host'

// Settings › Machines — the other computers that run the agent: what each
// one is, whether the box trusts it, and what the box asks of it. One card
// per machine, and the whole story on it: the decision about a machine and
// the policy sent to it are read together, so they sit together.
//
// Every machine keeps one link to the controller — the agent on this box —
// and the page reads them all from it (lib/dashboard/machines.ts). A key
// that connected and waits has a card with both fingerprints: the machine's,
// which its tray shows beside the controller's, and the controller's, so the
// two can be compared before approving. An approved machine's card carries
// its policy; a machine that is not connected shows what the box last knew.
//
// The second kind of setting on this page: Postgres, not site/. A decision
// or a policy reaches the controller as the desired set the moment it is
// saved, and a connected machine hears it at once — so each row saves on
// click, like Appearance, with no Apply bar. The policy rows appear only
// once a machine is approved: the box sends no policy to a key it has not.
//
// This file is the tab and one card per machine; the trust buttons are
// ./decision.tsx, the policy rows ./policy.tsx over ./use-policy-editor.ts,
// the install lines ./install.tsx, the controller's key rotation ./rotate.tsx, the
// session host's line ./session-host.tsx.

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
const BACK = 'Changes made here apply when the controller is back.'

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
  if (s.rolledBack !== null) {
    out.push({
      chip: `rolled back from ${s.rolledBack.version}`,
      tone: 'bad',
      title: `${s.rolledBack.version} started ${String(s.rolledBack.starts)} times without lasting; ${s.rolledBack.to} was put back at ${s.rolledBack.at}`,
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
  if (!s.awakeHold && !s.policy.awakeHold) return { chip: 'may sleep', tone: 'muted' }
  if (!s.awakeHold) return { chip: 'hold OFF', tone: 'bad' }
  if (s.updateAvailable !== null || s.restartPending) return { chip: 'updating', tone: 'warn' }
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
    const version = c.serverVersion ?? c.cliVersion
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
  if (s !== null && !s.trayReporting) {
    return (
      <span className={ASIDE}>
        {s.policy.claudeRemoteControl ? 'nobody logged on — the session is not reporting' : '—'}
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
function TunnelCell({ t }: { t: AgentTunnel }) {
  const up =
    t.error === null && t.lastHandshakeSecs !== null && t.lastHandshakeSecs < TUNNEL_STALE_SECS
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Line>
        <Chip tone={up ? 'ok' : 'warn'}>{up ? 'up' : 'down'}</Chip>
        {t.address !== '' && <Mono>{t.address}</Mono>}
        <span className={ASIDE}>
          {t.lastHandshakeSecs === null
            ? 'no handshake yet'
            : `handshake ${since(t.lastHandshakeSecs)}`}
          {` · ${bytes(t.rxBytes)} in · ${bytes(t.txBytes)} out`}
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
function TrustNote({ link }: { link: AgentLink | null }) {
  if (link === null || link.error === null || link.state !== 'key-changed') return null
  return <p className={ERROR_NOTE}>{link.error}</p>
}

/** One decided machine: the head, the facts, the decision, and — once approved — the policy. */
function MachineSection({
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
  const edition = s?.osName || (n.os ? n.os.charAt(0).toUpperCase() + n.os.slice(1) : 'unknown OS')
  const version = s?.osVersion ?? ''
  const arch = s?.arch || n.arch
  const v = verdict(m)

  const facts = [
    { k: 'Agent', v: <Mono>{s?.version ?? n.agentVersion}</Mono> },
    ...(s?.cpu ? [{ k: 'Processor', v: <Mono>{s.cpu}</Mono> }] : []),
    ...(s?.memoryBytes != null ? [{ k: 'Memory', v: <Mono>{bytes(s.memoryBytes)}</Mono> }] : []),
    {
      k: 'Machine up',
      v: <Mono>{s?.osUptimeSecs == null ? '—' : duration(s.osUptimeSecs)}</Mono>,
    },
    { k: 'Claude', v: <ClaudeCell m={m} /> },
    {
      k: 'Updates',
      v:
        s === null ? (
          <span className={ASIDE}>—</span>
        ) : s.restartPending ? (
          <Chip tone="warn">installed, restarting</Chip>
        ) : s.updateAvailable !== null ? (
          <Chip tone="warn">{s.updateAvailable} available</Chip>
        ) : (
          <span className={ASIDE}>
            {s.lastUpdateResult ?? 'not checked yet'}
            {s.lastUpdateCheck !== null && (
              <>
                {' · '}
                <Ago at={s.lastUpdateCheck} />
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
    ...(s?.link?.tunnel != null ? [{ k: 'Tunnel', v: <TunnelCell t={s.link.tunnel} /> }] : []),
    ...(s?.link != null ? [{ k: 'Its key', v: <Mono>{s.link.fingerprint}</Mono> }] : []),
    ...(s?.link?.rotated != null
      ? [{ k: 'Controller key', v: <span className={ASIDE}>{s.link.rotated}</span> }]
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
      {s?.holdError != null && <p className={NOTE}>The hold failed: {s.holdError}</p>}
      <TrustNote link={s?.link ?? null} />
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
function PendingSection({
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
            {p.agentVersion !== null && ` · agent ${p.agentVersion}`}
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
          v: p.lanIp === null ? <span className={ASIDE}>—</span> : <Mono>{p.lanIp}</Mono>,
        },
      ]}
    >
      <p className={NOTE}>
        The machine's tray and status page show both keys. Approve only if they match what it shows:
        its own, and the controller's it trusts.
      </p>
      <Decision m={m} />
    </Section>
  )
}

export function Machines({ d }: { d: MachinesData }) {
  // A machine's own "santree on the box" opens this page at
  // `?tab=machines&node=<id>&santree=on` (agent settings.rs `confirm_url`).
  const search = useSearch({ from: '/settings' })
  const c = d.controller
  const sync = d.sync
  return (
    <div className="flex flex-col gap-6">
      {d.machines.length === 0 ? (
        <Section
          title="Machines"
          icon={<MonitorSmartphoneIcon />}
          description="No machine has joined yet."
        >
          <p className={NOTE}>
            {d.listError !== null
              ? `The controller's list could not be read: ${d.listError}`
              : 'Install the agent on a machine with a line below and it appears here, waiting for you to approve it.'}
          </p>
        </Section>
      ) : (
        d.machines.map((m) =>
          m.node === null ? (
            <PendingSection
              key={m.pending?.id ?? ''}
              m={m}
              controllerFingerprint={c.reachable ? c.fingerprint : null}
            />
          ) : (
            <MachineSection
              key={m.node.id}
              m={m}
              lanDomain={d.lanDomain}
              askSantree={search.santree === 'on' && search.node === m.node.id}
            />
          ),
        )
      )}

      <Section
        title="The controller"
        icon={<NetworkIcon />}
        description="The agent on this box: every machine keeps one link to it, and this page reads them all through it."
        rows={
          c.reachable
            ? [
                {
                  k: 'Machines dial',
                  v:
                    c.address === null ? (
                      <span className={ASIDE}>no listener</span>
                    ) : (
                      <Mono>{c.address}</Mono>
                    ),
                },
                { k: 'Its key', v: <Mono>{c.fingerprint}</Mono> },
                ...(c.rotation !== null
                  ? [{ k: 'Rotating', v: <RotationState r={c.rotation} /> }]
                  : []),
                { k: 'Agent', v: <Mono>{c.version}</Mono> },
                ...(d.sessionHost !== null
                  ? [{ k: 'Session host', v: <SessionHost line={d.sessionHost} /> }]
                  : []),
                {
                  k: 'Decisions',
                  v:
                    sync === null ? (
                      <span className={ASIDE}>not sent since this process started</span>
                    ) : sync.error !== null ? (
                      <span className="inline-flex flex-col items-start gap-1">
                        <span className="text-[0.78rem] text-destructive">
                          not delivered <Ago at={sync.at} />: {sync.error}
                        </span>
                        <span className={ASIDE}>{BACK}</span>
                      </span>
                    ) : (
                      <span className={ASIDE}>
                        {String(sync.sent.length)} key{sync.sent.length === 1 ? '' : 's'} handed
                        over <Ago at={sync.at} />
                        {sync.skipped.length > 0 && ` · ${String(sync.skipped.length)} left out`}
                      </span>
                    ),
                },
              ]
            : [
                {
                  k: 'State',
                  v: (
                    <span className="inline-flex flex-col items-start gap-1">
                      <span className="text-[0.78rem] text-destructive">
                        not reachable: {c.error}
                      </span>
                      <span className={ASIDE}>{BACK}</span>
                    </span>
                  ),
                },
              ]
        }
      >
        {c.reachable && <RotateKey rotating={c.rotation !== null} />}
      </Section>

      <Section
        title="The gateway"
        icon={<MonitorSmartphoneIcon />}
        description="What every provider above offers becomes a route in LiteLLM, kept in step by the box."
      >
        <Rows
          rows={[
            { k: 'This box', v: <BoxProvider /> },
            { k: 'Sync', v: <GatewaySync /> },
          ]}
        />
      </Section>

      <Section title="How a machine joins" icon={<MonitorSmartphoneIcon />}>
        <Install controller={c} />
      </Section>
    </div>
  )
}
