// A node's Host tab, its second half: the machine, what runs on it, what it offers.

import { Link } from '@tanstack/react-router'
import { Ago } from '../../../../components/ago'
import { PART, PART_DETAIL, PART_ID, PART_NAME, PartPhoto } from '../../../../components/part'
import { Board, Chip, Facts } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, duration, num, rate, text } from '../../../../lib/format'
import { linkWords } from '../../../../lib/node-link'
import { PROVIDER_NAME, type ProviderKind } from '../../../../lib/providers/kinds'
import type { HostFacts } from './host'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from './shared'
import { AgentUpdate } from './updates'

export function MachineBoard({ f }: { f: HostFacts }) {
  const { node, t, status, mark, machinePart } = f
  return (
    <Board title="The machine" icon="▣" span={4}>
      <div className={PART}>
        {machinePart !== null ? (
          <PartPhoto part={machinePart} />
        ) : (
          mark !== undefined && (
            <img
              src={mark.src}
              alt=""
              width={56}
              height={56}
              className={cn('block size-14 flex-none object-contain', mark.invert && 'dark:invert')}
            />
          )
        )}
        <div className={PART_ID}>
          <strong className={PART_NAME}>{t.machine.model ?? node.name}</strong>
          <span className={PART_DETAIL}>
            {[t.machine.manufacturer, t.machine.form].filter(Boolean).join(' · ') || 'make unread'}
            {t.machine.chip ? ` · ${t.machine.chip}` : ''}
          </span>
          <span className={PART_DETAIL}>
            {t.os.kernel === null
              ? 'kernel unread'
              : `${node.os === 'macos' ? 'Darwin' : 'NT'} ${t.os.kernel}`}
            , up {duration(status.os_uptime_secs)}.
          </span>
        </div>
      </div>
      <p className={FOOT}>
        The specification is on <b>Build</b>. Its address on the network is{' '}
        <span className={MONO}>{node.lanIp ?? DASH}</span>, hardware address{' '}
        <span className={MONO}>{text(node.mac)}</span>.
      </p>
    </Board>
  )
}

export function RunningBoard({ f }: { f: HostFacts }) {
  const { node, t, status } = f
  return (
    <Board title="Running" icon="▣" span={4}>
      <Facts
        rows={[
          { k: 'Uptime', v: duration(status.os_uptime_secs) },
          {
            k: 'Booted',
            v: status.booted_at === null ? DASH : <Ago at={status.booted_at} />,
          },
          {
            k: 'Kernel',
            v: t.os.kernel === null ? DASH : <span className={MONO}>{t.os.kernel}</span>,
          },
          { k: 'Processes', v: num(t.process_count) },
          {
            k: node.os === 'macos' ? 'Jobs failing' : 'Services down',
            v:
              t.services.length > 0 ? (
                <Chip tone="bad">{num(t.services.length)}</Chip>
              ) : (
                <Chip tone="ok">none</Chip>
              ),
          },
        ]}
      />
    </Board>
  )
}

export function ServicesBoard({ f }: { f: HostFacts }) {
  const { node, t } = f
  return (
    <Board
      title={
        t.services.length === 0
          ? node.os === 'macos'
            ? 'No failing jobs'
            : 'No services down'
          : node.os === 'macos'
            ? 'Failing jobs'
            : 'Services down'
      }
      icon="⚑"
      span={t.battery === null ? 8 : 4}
      aside={
        t.services.length === 0 ? (
          <Chip tone="ok">none</Chip>
        ) : (
          <Chip tone="bad">{num(t.services.length)}</Chip>
        )
      }
    >
      {t.services.length === 0 ? (
        <p className={EMPTY}>
          {node.os === 'macos'
            ? `Nothing outside Apple's own launchd jobs exited with an error${t.service_count === null ? '' : `, of ${num(t.service_count)} loaded`}.`
            : `Every Automatic service is running or stopped cleanly${t.service_count === null ? '' : `, of ${num(t.service_count)} installed`}.`}
        </p>
      ) : (
        <ul className={LIST}>
          {t.services.map((s) => (
            <li key={s.name} className={ROW}>
              <Chip tone="bad">{s.state}</Chip>
              <span className={cn(ROW_MAIN, MONO)}>{s.name}</span>
              <span className={ROW_SIDE}>
                {s.display ?? ''}
                {s.exit_code !== null && ` · exit ${String(s.exit_code)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        {node.os === 'macos'
          ? 'launchd jobs in the system domain whose last exit was not zero, Apple’s own left out because half of them exit non-zero by design. The box’s equivalent is its failed units.'
          : 'Services set to start automatically that are stopped with an exit code other than clean or never-started — the Windows reading of the box’s failed units. A service that simply finished its work and exited zero is not listed.'}{' '}
        Read every ten minutes.
      </p>
    </Board>
  )
}

export function NetworkBoard({ f }: { f: HostFacts }) {
  const { t } = f
  return (
    <Board
      title="Network"
      icon="⇵"
      span={4}
      aside={<span className={NOTE}>{num(t.network.length)} up</span>}
    >
      {t.network.length === 0 ? (
        <p className={EMPTY}>No interfaces up.</p>
      ) : (
        <ul className={LIST}>
          {t.network.map((n) => (
            <li key={n.interface} className={`${ROW} flex-wrap`}>
              <span className={cn(ROW_MAIN, MONO)}>{n.interface}</span>
              <span className={`${ROW_SIDE} tabular-nums`}>
                ↓ {rate(n.rx_bps)} · ↑ {rate(n.tx_bps)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Bytes per second since the previous sample, on the interfaces that are up. Since boot:{' '}
        {t.network.reduce((s, n) => s + (n.rx_bytes ?? 0), 0) > 0
          ? `${num(Math.round(t.network.reduce((s, n) => s + (n.rx_bytes ?? 0), 0) / 1e9))} GB in, ${num(Math.round(t.network.reduce((s, n) => s + (n.tx_bytes ?? 0), 0) / 1e9))} GB out`
          : DASH}
        .
      </p>
    </Board>
  )
}

export function ProvidersBoard({ f }: { f: HostFacts }) {
  const { providers } = f
  return (
    <Board
      title="Providers"
      icon="◈"
      span={12}
      aside={
        providers === null ? (
          <span className={NOTE}>no report yet</span>
        ) : providers.length === 0 ? (
          <span className={NOTE}>none found</span>
        ) : providers.every((p) => p.running) ? (
          <Chip tone="ok">{num(providers.length)} running</Chip>
        ) : (
          <Chip tone="warn">
            {num(providers.filter((p) => p.running).length)} of {num(providers.length)} running
          </Chip>
        )
      }
    >
      {providers === null ? (
        <p className={EMPTY}>This machine's agent has not reported its providers yet.</p>
      ) : providers.length === 0 ? (
        <p className={EMPTY}>No model server found on this machine.</p>
      ) : (
        <ul className={LIST}>
          {providers.map((p) => (
            <li key={`${p.kind}:${String(p.port)}`} className={ROW}>
              {!p.running ? (
                <Chip tone="warn">found, not running</Chip>
              ) : p.healthy ? (
                <Chip tone="ok">running</Chip>
              ) : (
                <Chip tone="bad">unhealthy</Chip>
              )}
              <span className={ROW_MAIN}>
                {providerName(p.kind)}
                {p.version !== null && (
                  <span className="ml-[0.4rem] text-muted-foreground">v{p.version}</span>
                )}
              </span>
              <span className={cn(ROW_SIDE, MONO)}>
                {p.running
                  ? `${p.models === null ? 'catalog unknown' : `${num(p.models.filter((m) => m.downloaded).length)} on disk`} · ${num(p.loaded.length)} loaded · `
                  : ''}
                port {String(p.port)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        What this machine offers the network beyond itself, as its agent reads it on the machine's
        own loopback and reports it through the controller. The box never dials the server for this;
        only the gateway's model requests go to it, at this machine's name.
      </p>
    </Board>
  )
}

export function AgentBoard({ f }: { f: HostFacts }) {
  const { node, status } = f
  return (
    <Board
      title="Agent"
      icon="◎"
      span={12}
      aside={
        status.restart_pending ? (
          <Chip tone="ok">installed, restarting</Chip>
        ) : status.update_available !== null ? (
          <Chip tone="warn">{status.update_available}</Chip>
        ) : (
          <span className={MONO}>{status.version}</span>
        )
      }
    >
      <Facts
        rows={[
          { k: 'Running', v: <span className={MONO}>{status.version}</span> },
          {
            k: 'Updates',
            v: status.restart_pending
              ? 'installed, restarting'
              : (status.update_available ?? status.last_update_result ?? 'not checked yet'),
          },
          {
            k: 'Box',
            v: `approved · ${linkWords(node)}`,
          },
          { k: 'Tray', v: status.tray.reporting ? 'reporting' : 'not reporting' },
          {
            k: 'Claude',
            v:
              status.claude != null
                ? `${status.claude.state}${status.claude.server_version !== null ? ` ${status.claude.server_version}` : ''} · ${String(status.claude.sessions)} session${status.claude.sessions === 1 ? '' : 's'}`
                : DASH,
          },
        ]}
      />
      <AgentUpdate node={node} />
      <p className={FOOT}>
        The agent&rsquo;s own state, and the one thing on this page that this box moves: releases
        are signed by its key, the agent verifies the signature and swaps its own binary within ten
        minutes, or now from the button. Every switch for this machine is on{' '}
        <Link to="/settings" search={{ tab: 'machines' }}>
          Settings › Machines
        </Link>
        , and its Claude remote control on{' '}
        <Link
          to="/c/$category"
          params={{ category: 'system' }}
          search={{ tab: 'claude', machine: node.id }}
        >
          Claude
        </Link>
        . The agent&rsquo;s log is on the machine, in its tray menu; nothing ships it here yet.
      </p>
    </Board>
  )
}

/**
 * The product name for a provider kind, from the one map that defines them
 * (lib/providers/kinds.ts). The agent reports `kind` as free text, so a kind
 * this page predates reads as itself rather than as a blank — a newer agent
 * must not render an empty row here.
 */
function providerName(kind: string): string {
  return Object.hasOwn(PROVIDER_NAME, kind) ? PROVIDER_NAME[kind as ProviderKind] : kind
}
