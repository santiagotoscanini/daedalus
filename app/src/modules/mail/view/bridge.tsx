import { Ago } from '../../../components/ago'
import { QuietState } from '../../../components/modules/parts'
import { verdictOf } from '../../../components/service-head'
import { CAPTION, FOOT, LIVE, MONO } from '../../../components/tokens'
import { Board, Chip, Facts, Pulse } from '../../../components/viz'
import { DASH } from '../../../lib/format'
import type { BridgeReport, BridgeStatus } from '../data/bridge'
import { type Bridge, busy } from './shared'

// Email › the Bridge board: the program itself — which release, whether it
// can reach Proton, what it listens on, and whether it is reporting at all.

export function BridgeBoard({ bridge, report }: { bridge: Bridge; report: BridgeReport }) {
  const s = report.status
  return (
    <Board title="Bridge" span={4} spanMd={12} aside={<Reporting report={report} />}>
      <Facts
        list
        rows={[
          { k: 'Version', v: <Version bridge={bridge} /> },
          ...(report.reporting && s !== null
            ? [
                { k: 'Proton', v: <Online online={s.online} /> },
                { k: 'IMAP', v: <Listener l={s.imap} /> },
                { k: 'SMTP', v: <Listener l={s.smtp} /> },
                { k: 'Started', v: <Ago at={s.startedAt} /> },
              ]
            : [{ k: 'Last report', v: s === null ? 'none' : <Ago at={s.updatedAt} /> }]),
        ]}
      />
      {!report.reporting && (
        <p className={CAPTION}>
          {report.error !== null
            ? `The status file could not be read: ${report.error}`
            : s === null
              ? 'Bridge has written no status since the box started.'
              : 'Silent for over two minutes: the container is down or restarting.'}
        </p>
      )}
      <p className={FOOT}>
        A supervisor beside Bridge writes this status on every change and at least every 30 seconds,
        so silence means it is not running. <b>Proton</b> is whether Bridge can reach Proton&rsquo;s
        servers; while it cannot, Bridge closes both listeners until it can. The ports are local to
        Bridge, and SSL means the listener speaks TLS from the first byte rather than by STARTTLS.
      </p>
    </Board>
  )
}

/** The header's reading: alive (with when it last said so), starting, or silent. */
function Reporting({ report }: { report: BridgeReport }) {
  const s = report.status
  if (!report.reporting || s === null) return <Chip tone="bad">not reporting</Chip>
  if (s.phase === 'starting') return <Chip tone="info">starting</Chip>
  return (
    <span className={LIVE}>
      <Pulse on={busy(report)} tone="accent" />
      updated <Ago at={s.updatedAt} />
    </span>
  )
}

/** The running release and its verdict against Proton's, on one line. */
function Version({ bridge }: { bridge: Bridge }) {
  const verdict = verdictOf(bridge.gap)
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      <span
        className={MONO}
        title={bridge.versionFrom === 'bridge' ? 'as Bridge reports it' : 'the build this box pins'}
      >
        {bridge.gap.installed ?? DASH}
      </span>
      <Chip tone={verdict.tone === 'ok' ? 'muted' : verdict.tone}>{verdict.label}</Chip>
    </span>
  )
}

function Online({ online }: { online: boolean | null }) {
  if (online === null) return <QuietState>not reported yet</QuietState>
  return online ? 'reachable' : <Chip tone="bad">unreachable</Chip>
}

function Listener({ l }: { l: BridgeStatus['imap'] }) {
  if (l.port === 0) return DASH
  return (
    <>
      <span className={MONO}>{l.port}</span> · {l.ssl ? 'SSL' : 'STARTTLS'}
    </>
  )
}
