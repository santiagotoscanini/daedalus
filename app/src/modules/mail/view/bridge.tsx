import type { ReactNode } from 'react'
import { Ago } from '../../../components/ago'
import { FOOT, MONO, SUB } from '../../../components/tokens'
import { Board, Chip, Facts } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes } from '../../../lib/format'
import type { BridgeReport, BridgeSettings, BridgeStatus } from '../data/bridge'

// Email › Bridge itself: whether it can reach Proton and what it listens on,
// then the settings it runs with and the size of what it keeps on disk.

type Row = { k: string; v: ReactNode }

export function BridgeBoard({ report }: { report: BridgeReport }) {
  const s = report.status
  const rows: Row[] =
    report.reporting && s !== null
      ? [
          ...(s.online === null
            ? []
            : [{ k: 'Proton', v: s.online ? 'reachable' : <Chip tone="bad">unreachable</Chip> }]),
          ...listener('IMAP', s.imap),
          ...listener('SMTP', s.smtp),
          { k: 'Started', v: <Ago at={s.startedAt} /> },
        ]
      : s === null
        ? []
        : [{ k: 'Last report', v: <Ago at={s.updatedAt} /> }]
  if (rows.length === 0) return null

  return (
    <Board title="Bridge" span={4} spanMd={12}>
      <Facts list rows={rows} />
      <p className={FOOT}>
        <b>Proton</b> is Bridge&rsquo;s own verdict: it opens its IMAP listener only while
        Proton&rsquo;s servers answer. The ports are local to Bridge, and SSL means the listener
        speaks TLS from the first byte rather than by STARTTLS.
      </p>
    </Board>
  )
}

function listener(k: string, l: BridgeStatus['imap']): Row[] {
  if (l.port === 0) return []
  return [
    {
      k,
      v: (
        <>
          <span className={MONO}>{l.port}</span> · {l.ssl ? 'SSL' : 'STARTTLS'}
        </>
      ),
    },
  ]
}

const onOff = (v: boolean): string => (v ? 'on' : 'off')

/** Each setting Bridge answered for, in the words its own settings use. */
function settingRows(x: BridgeSettings): Row[] {
  const rows: Row[] = []
  if (x.keychain !== undefined)
    rows.push({ k: 'Keychain', v: <span className={MONO}>{x.keychain}</span> })
  if (x.allMailVisible !== undefined)
    rows.push({ k: 'All Mail folder', v: x.allMailVisible ? 'shown' : 'hidden' })
  if (x.alternativeRouting !== undefined)
    rows.push({ k: 'Alternative routing', v: onOff(x.alternativeRouting) })
  if (x.telemetryDisabled !== undefined)
    rows.push({ k: 'Telemetry', v: onOff(!x.telemetryDisabled) })
  if (x.automaticUpdates !== undefined)
    rows.push({ k: 'Automatic updates', v: onOff(x.automaticUpdates) })
  if (x.earlyAccess !== undefined) rows.push({ k: 'Early access', v: onOff(x.earlyAccess) })
  return rows
}

export function SettingsBoard({ status: s }: { status: BridgeStatus }) {
  const settings = settingRows(s.settings)
  const disk: Row[] =
    s.disk === null
      ? []
      : [
          { k: 'Message store', v: bytes(s.disk.messageStoreBytes) },
          { k: 'Search index', v: bytes(s.disk.indexBytes) },
          { k: 'Measured', v: <Ago at={s.disk.measuredAt} /> },
        ]
  if (settings.length === 0 && disk.length === 0) return null

  return (
    <Board title="Settings and storage" span={4} spanMd={12}>
      {settings.length > 0 && <Facts list rows={settings} />}
      {disk.length > 0 && (
        <>
          <p className={cn(SUB, settings.length === 0 && 'mt-0')}>On disk</p>
          <Facts list rows={disk} />
        </>
      )}
      <p className={FOOT}>
        The keychain is where Bridge keeps each account&rsquo;s session. Alternative routing reaches
        Proton through third-party networks when its own servers are blocked. On disk is the local
        copy of every message Bridge has synced, and the index it searches.
      </p>
    </Board>
  )
}
