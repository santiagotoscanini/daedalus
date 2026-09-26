import { MonitorSmartphoneIcon } from 'lucide-react'

import { agentHasClaude } from '../../../lib/agent/status'
import { cn } from '../../../lib/cn'
import type { Machine, MachinesData } from '../../../lib/dashboard/machines'
import { bytes, duration, since } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import { Chip } from '../../viz'
import { BoxProvider, GatewaySync } from '../provider-models'
import { ASIDE, Line, MONO, Mono, NOTE, Rows, Section } from '../shared'
import { Decision } from './decision'
import { Policy } from './policy'

// Settings › Machines — the other computers on this network that run the
// agent: what each one is, whether the box trusts it, and what the box asks
// of it. One card per machine, and the whole story on it: the decision about a
// machine and the policy sent to it are read together, so they sit together.
//
// Two kinds of machine, told apart by the chip. One that said hello has a
// node row and a state — pending until approved, approved, or revoked — and
// the buttons act on that row. One that was merely found (its status page
// answers, but no hello reached the box) has no identity the box can act on;
// the card says why and what to do.
//
// The second kind of setting on this page: Postgres, not site/. A policy
// travels to its machine on the answer to the agent's next hello, so a
// switch here reaches the machine within a minute and nothing rebuilds —
// which is why each row saves on click, like Appearance, with no Apply bar.
// The policy rows appear only once a machine is approved: the box does not
// send a policy to a machine it has not approved, and a switch that appears
// to do nothing is worse than none.
//
// The install line is on the page rather than in a doc: a machine that is
// not here yet is one shell line away, and this is where the person
// looking for it is standing.
//
// This file is the tab and one card per machine; the trust buttons are
// ./decision.tsx, the policy rows ./policy.tsx over ./use-policy-editor.ts.

const INSTALL_WINDOWS = 'irm https://daedalus.toscanini.me/install.ps1 | iex'
const INSTALL_MACOS = 'curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh'

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

/**
 * Claude Code on the machine, in one line: what the tray reports through the
 * status page when it answers, the last hello's summary when it does not.
 * The Claude page's picker is where the rest is.
 */
function ClaudeCell({ m }: { m: Machine }) {
  const s = m.status
  const c = s?.claude ?? null
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
  if (s !== null && !agentHasClaude(s.version)) {
    return <span className={ASIDE}>needs agent 0.4.0 (has {s.version})</span>
  }
  if (s !== null && !s.trayReporting) {
    return (
      <span className={ASIDE}>
        {s.policy.claudeRemoteControl ? 'nobody logged on — the tray is not reporting' : '—'}
      </span>
    )
  }
  const h = m.node?.claude ?? null
  if (h !== null) {
    return (
      <span className={ASIDE}>
        {h.state}
        {h.serverVersion !== null && ` ${h.serverVersion}`} · {String(h.sessions)} session
        {h.sessions === 1 ? '' : 's'} · from the last hello
      </span>
    )
  }
  return <span className={ASIDE}>—</span>
}

/** One machine: the head, the facts, the decision, and — once approved — the policy. */
function MachineSection({ m, port, lanDomain }: { m: Machine; port: number; lanDomain: string }) {
  const s = m.status
  const os = s?.os ?? m.node?.os ?? ''
  const mark = osMark(os)
  const edition = s?.osName || (os ? os.charAt(0).toUpperCase() + os.slice(1) : 'unknown OS')
  const version = s?.osVersion ?? ''
  const arch = s?.arch || m.node?.arch || ''
  const v = verdict(m)

  const facts = [
    { k: 'Agent', v: <Mono>{s?.version ?? m.node?.agentVersion ?? '—'}</Mono> },
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
            {s.lastUpdateCheck !== null &&
              ` · ${since((Date.now() - Date.parse(s.lastUpdateCheck)) / 1000)}`}
          </span>
        ),
    },
    {
      k: 'Address',
      v:
        m.ip === null ? (
          <span className={ASIDE}>—</span>
        ) : (
          <a
            href={`http://${m.ip}:${String(port)}/status`}
            target="_blank"
            rel="noreferrer"
            className={cn(MONO, 'hover:text-foreground')}
          >
            {m.ip}:{port}
          </a>
        ),
    },
    ...(m.node?.mac != null ? [{ k: 'Hardware address', v: <Mono>{m.node.mac}</Mono> }] : []),
  ]

  return (
    <Section
      title={m.node?.name || s?.hostname || m.lanName || m.ip || 'Machine'}
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
      <Decision m={m} />
      {m.node !== null && m.node.state === 'approved' && (
        <Policy n={m.node} shape={m.shape} lanDomain={lanDomain} />
      )}
    </Section>
  )
}

export function Machines({ d }: { d: MachinesData }) {
  return (
    <div className="flex flex-col gap-6">
      {d.machines.length === 0 ? (
        <Section
          title="Machines"
          icon={<MonitorSmartphoneIcon />}
          description="No machine has announced itself yet."
        >
          <p className={NOTE}>
            {d.error !== null
              ? `The LAN device list could not be read: ${d.error}`
              : `None of the ${String(d.probed)} devices asked answered the agent's status page either. Install the agent on a machine and it appears here.`}
          </p>
        </Section>
      ) : (
        d.machines.map((m) => (
          <MachineSection
            key={m.node?.id ?? m.ip ?? m.lanName ?? ''}
            m={m}
            port={d.port}
            lanDomain={d.lanDomain}
          />
        ))
      )}

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
        <p className={NOTE}>Install the agent on it. Windows, from an administrator PowerShell:</p>
        <p className={cn(MONO, 'm-0 select-all')}>{INSTALL_WINDOWS}</p>
        <p className={NOTE}>A Mac, from a terminal:</p>
        <p className={cn(MONO, 'm-0 select-all')}>{INSTALL_MACOS}</p>
        <p className={NOTE}>
          The agent keeps the machine awake, shows itself in the tray or the menu bar, updates
          itself from each release, and announces itself to this box every minute with a key it made
          at install — the machine then appears above as "wants to join" until you approve it. The
          page also asks every device pi-hole has seen in the last week for the agent's status page
          on TCP {String(d.port)} ({String(d.probed)} asked just now
          {d.skipped > 0 && `, ${String(d.skipped)} too long silent`}), so an agent that cannot find
          the box is still seen.
        </p>
      </Section>

      <p className={NOTE}>
        Each switch reaches its machine on the agent's next hello, within a minute. Approve, revoke
        and update take effect the same way.
      </p>
    </div>
  )
}
