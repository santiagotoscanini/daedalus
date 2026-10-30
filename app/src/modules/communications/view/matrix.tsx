import type { ReactNode } from 'react'
import { Ago } from '../../../components/ago'
import { LogBoard } from '../../../components/logs'
import { useLiveValue } from '../../../components/poll'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import { EMPTY, FOOT, LIVE, MONO } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Pulse, Stat, StatStrip } from '../../../components/viz'
import type { AppResources } from '../../../lib/apps/metrics'
import { num } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import { fetchMatrixReportFn } from '../../../server/communications'
import type { BridgeLogin, LoginState, MatrixReport } from '../data/matrix'
import type { Matrix } from './shared'

// Communications › the Matrix tab: the private homeserver as its helper
// reports it, the WhatsApp login the bridge holds, the two containers that
// matter, their release notes and the stack's log.

/** While a login is being made or is reconnecting: the helper writes every 30 s. */
const BUSY_MS = 5_000
const IDLE_MS = 30_000

const MB = 1024 * 1024
const mb = (b: number): string => num(Math.round(b / MB))

type Row = { k: string; v: ReactNode }

/** The bridge's states in the words a row says them; the norm recedes. */
const STATE: Record<string, { label: string; tone: Tone }> = {
  CONNECTED: { label: 'connected', tone: 'ok' },
  CONNECTING: { label: 'connecting', tone: 'info' },
  BACKFILLING: { label: 'syncing history', tone: 'info' },
  TRANSIENT_DISCONNECT: { label: 'reconnecting', tone: 'warn' },
  BAD_CREDENTIALS: { label: 'unlinked', tone: 'bad' },
  LOGGED_OUT: { label: 'logged out', tone: 'bad' },
  UNKNOWN_ERROR: { label: 'error', tone: 'bad' },
}
const stateOf = (s: LoginState): { label: string; tone: Tone } =>
  STATE[s] ?? { label: s.toLowerCase().replace(/_/g, ' '), tone: 'muted' }

const moving = (r: MatrixReport): boolean =>
  r.status?.whatsapp.logins.some((l) => l.state !== 'CONNECTED') ?? false

export function MatrixView({ data: d }: { data: Matrix }) {
  const report = useLiveValue<MatrixReport>(
    d.report,
    () => fetchMatrixReportFn(),
    (r) => (moving(r) ? BUSY_MS : IDLE_MS),
    () => true,
  )
  const s = report.reporting ? report.status : null

  return (
    <>
      <ServiceHead
        logo="/icon-matrix.svg"
        name="Matrix"
        version={d.synapse.gap.installed}
        versionNote="Synapse, as it reports itself"
        verdict={verdictOf(d.synapse.gap)}
        compare={compareOf(d.synapse.gap, 'as Synapse reports it')}
        lede="A private homeserver that carries this box’s chat bridges. It federates with no one, takes no sign-ups, and listens only inside its own network namespace."
        actions={<Reporting report={report} />}
      />
      <Strip synapse={d.synapse.resources} whatsapp={d.whatsapp.resources} />
      <BoardGrid>
        <HomeserverBoard report={report} />
        <WhatsAppBoard report={report} version={d.whatsapp.gap.installed} />
        {s !== null && s.whatsapp.logins.length === 0 && <LinkBoard />}
        <Changelog
          gap={d.synapse.gap}
          title="Synapse releases"
          span={12}
          foot={
            <p className={FOOT}>
              Element&rsquo;s releases, from the running version to the newest. The image is
              Element&rsquo;s own, pinned by digest and signed by their release workflow; check the
              signature before moving the pin.
            </p>
          }
        />
        <Changelog
          gap={d.whatsapp.gap}
          title="mautrix-whatsapp releases"
          span={12}
          foot={
            <p className={FOOT}>
              The bridge releases monthly and supports only its latest release. The box builds it
              from the tagged source through nixpkgs, so it moves when the nixpkgs pin does.
            </p>
          }
        />
        <LogBoard
          source={{ stack: 'matrix' }}
          title="Matrix logs"
          foot={
            <p className={FOOT}>
              Synapse, the bridge and the helper, at info and above. Neither logs message text at
              that level, and the helper&rsquo;s own polls are dropped before they ship.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

function Reporting({ report }: { report: MatrixReport }) {
  const s = report.status
  if (!report.reporting || s === null) return <Chip tone="bad">not reporting</Chip>
  return (
    <span className={LIVE}>
      <Pulse on={moving(report)} tone="accent" />
      updated <Ago at={s.generatedAt} />
    </span>
  )
}

function Strip({ synapse, whatsapp }: { synapse: AppResources; whatsapp: AppResources }) {
  const cells = [
    synapse.memory.used !== null && (
      <Stat
        key="synapse"
        label="Synapse memory"
        value={mb(synapse.memory.used)}
        unit={synapse.memory.limit === null ? 'MB' : `of ${mb(synapse.memory.limit)} MB`}
        spark={synapse.memory.spark}
        title="memory.current, page cache included"
      />
    ),
    whatsapp.memory.used !== null && (
      <Stat
        key="whatsapp"
        label="Bridge memory"
        value={mb(whatsapp.memory.used)}
        unit={whatsapp.memory.limit === null ? 'MB' : `of ${mb(whatsapp.memory.limit)} MB`}
        spark={whatsapp.memory.spark}
        title="memory.current, page cache included"
      />
    ),
    ...[synapse, whatsapp].map(
      (r, i) =>
        r.oomKills !== null &&
        r.oomKills > 0 && (
          <Stat
            key={`oom-${String(i)}`}
            label={i === 0 ? 'Synapse OOM kills' : 'Bridge OOM kills'}
            value={num(r.oomKills)}
            tone="bad"
          />
        ),
    ),
  ].filter((c) => c !== false)
  return cells.length === 0 ? null : <StatStrip>{cells}</StatStrip>
}

function silent(report: MatrixReport): string {
  if (report.error !== null) return `The status file could not be read: ${report.error}`
  if (report.status === null)
    return 'The stack’s helper has written no status since the box started.'
  return 'The helper has been silent for over two minutes: the stack is down or restarting.'
}

function HomeserverBoard({ report }: { report: MatrixReport }) {
  const s = report.reporting ? report.status : null
  if (s === null) {
    return (
      <Board title="Homeserver" span={6} spanMd={12}>
        <p className={EMPTY}>{silent(report)}</p>
      </Board>
    )
  }
  const hs = s.homeserver
  const op = s.operator
  const rows: Row[] = [
    { k: 'Server name', v: <span className={MONO}>{hs.serverName}</span> },
    {
      k: 'Synapse',
      v: hs.healthy ? 'answering' : <Chip tone="bad">{hs.error === '' ? 'down' : hs.error}</Chip>,
    },
    { k: 'Account', v: <span className={MONO}>{op.mxid}</span> },
    {
      k: 'Signed in',
      v: op.signedIn ? 'yes' : <Chip tone="bad">{op.error === '' ? 'no' : op.error}</Chip>,
    },
    ...(op.joinedRooms === null ? [] : [{ k: 'Joined rooms', v: num(op.joinedRooms) }]),
  ]
  return (
    <Board title="Homeserver" span={6} spanMd={12}>
      <Facts rows={rows} />
      <p className={FOOT}>
        The <b>server name</b> is in every user and room ID and can never change. Federation and
        registration are off; the one account is the one logged into the bridges, so what it sends
        in a bridged chat leaves as that network&rsquo;s account. Messages are stored unencrypted,
        in a database the read-only database role cannot open.
      </p>
    </Board>
  )
}

function loginRows(l: BridgeLogin): Row[] {
  const st = stateOf(l.state)
  return [
    {
      k: l.name === '' ? 'Account' : l.name,
      v: <Chip tone={st.tone}>{st.label}</Chip>,
    },
    ...(l.phone === '' ? [] : [{ k: 'Phone', v: <span className={MONO}>{l.phone}</span> }]),
    ...(l.since === null ? [] : [{ k: 'Since', v: <Ago at={l.since * 1000} /> }]),
    ...(l.message === '' ? [] : [{ k: 'Bridge says', v: l.message }]),
  ]
}

function WhatsAppBoard({ report, version }: { report: MatrixReport; version: string | null }) {
  const s = report.reporting ? report.status : null
  if (s === null) return null
  const w = s.whatsapp
  const rows: Row[] = [
    { k: 'Bridge', v: w.ready ? 'ready' : <Chip tone="bad">not ready</Chip> },
    ...(version === null ? [] : [{ k: 'Version', v: <span className={MONO}>{version}</span> }]),
    ...(w.error === '' ? [] : [{ k: 'Asking it', v: <Chip tone="bad">{w.error}</Chip> }]),
    ...w.logins.flatMap(loginRows),
  ]
  const worst = w.logins.find((l) => stateOf(l.state).tone === 'bad')
  return (
    <Board
      title="WhatsApp"
      span={6}
      spanMd={12}
      aside={
        w.logins.length === 0 ? (
          <Chip tone="warn">not linked</Chip>
        ) : worst === undefined ? undefined : (
          <Chip tone="bad">{stateOf(worst.state).label}</Chip>
        )
      }
    >
      <Facts rows={rows} />
      <p className={FOOT}>
        The bridge is a linked device of the phone&rsquo;s account, like WhatsApp Web. The phone has
        to come online at least every two weeks or WhatsApp drops every linked device; the bridge
        warns at twelve days. Removing it from the phone&rsquo;s <b>Linked devices</b> cuts it off
        at once.
      </p>
    </Board>
  )
}

function LinkBoard() {
  return (
    <Board title="Link WhatsApp" span={12}>
      <Facts
        rows={[
          { k: 'With a QR code', v: <span className={MONO}>matrix-whatsapp-link qr</span> },
          {
            k: 'With a code instead',
            v: <span className={MONO}>matrix-whatsapp-link phone +&lt;number&gt;</span>,
          },
          { k: 'To unlink', v: <span className={MONO}>matrix-whatsapp-link logout</span> },
        ]}
      />
      <p className={FOOT}>
        From a terminal on the box. On the phone, open WhatsApp&rsquo;s <b>Linked devices</b> and{' '}
        <b>Link a device</b>, then scan the code (a new one every 20 seconds) or choose{' '}
        <b>Link with phone number instead</b> and type the eight characters. An account with a
        passkey may be asked for it after the scan, which only web.whatsapp.com can answer.
      </p>
    </Board>
  )
}
