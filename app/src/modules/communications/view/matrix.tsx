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
import type { BridgeLogin, BridgeStatus, LoginState, MatrixReport } from '../data/matrix'
import type { Matrix } from './shared'

// Communications › the Matrix tab: the private homeserver as its helper
// reports it, each bridge's logins (WhatsApp, and LinkedIn where the box
// carries it), the containers that matter, their release notes and the
// stack's log.

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
  [r.status?.whatsapp, r.status?.linkedin].some(
    (b) => b?.logins.some((l) => l.state !== 'CONNECTED') ?? false,
  )

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
      <Strip
        cells={[
          { key: 'synapse', label: 'Synapse', r: d.synapse.resources },
          { key: 'whatsapp', label: 'WhatsApp bridge', r: d.whatsapp.resources },
          ...(s?.linkedin == null
            ? []
            : [{ key: 'linkedin', label: 'LinkedIn bridge', r: d.linkedin.resources }]),
        ]}
      />
      <BoardGrid>
        <HomeserverBoard report={report} />
        {s !== null && (
          <BridgeBoard
            title="WhatsApp"
            bridge={s.whatsapp}
            version={d.whatsapp.gap.installed}
            foot={
              <>
                The bridge is a linked device of the phone&rsquo;s account, like WhatsApp Web. The
                phone has to come online at least every two weeks or WhatsApp drops every linked
                device; the bridge warns at twelve days. Removing it from the phone&rsquo;s{' '}
                <b>Linked devices</b> cuts it off at once.
              </>
            }
          />
        )}
        {s?.linkedin != null && (
          <BridgeBoard
            title="LinkedIn"
            bridge={s.linkedin}
            version={d.linkedin.gap.installed}
            foot={
              <>
                The bridge holds a signed-in LinkedIn session, the way a browser does. LinkedIn ends
                such sessions when it likes; a login that turns <b>unlinked</b> or <b>logged out</b>{' '}
                is fixed by linking again. Signing out of all sessions in LinkedIn&rsquo;s settings
                cuts it off at once.
              </>
            }
          />
        )}
        {s !== null && s.whatsapp.logins.length === 0 && <LinkWhatsAppBoard />}
        {s?.linkedin != null && s.linkedin.logins.length === 0 && <LinkLinkedInBoard />}
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
        {s?.linkedin != null && (
          <Changelog
            gap={d.linkedin.gap}
            title="mautrix-linkedin releases"
            span={12}
            foot={
              <p className={FOOT}>
                The box may build a reviewed commit past the release shown as running; the stack
                names the commit. Move it after reading what landed since.
              </p>
            }
          />
        )}
        <LogBoard
          source={{ stack: 'matrix' }}
          title="Matrix logs"
          foot={
            <p className={FOOT}>
              Synapse, the bridges and the helper, at info and above. None logs message text at that
              level, and the helper&rsquo;s own polls are dropped before they ship.
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

type StripCell = { key: string; label: string; r: AppResources }

function Strip({ cells: from }: { cells: StripCell[] }) {
  const cells = [
    ...from.map(
      ({ key, label, r }) =>
        r.memory.used !== null && (
          <Stat
            key={key}
            label={`${label} memory`}
            value={mb(r.memory.used)}
            unit={r.memory.limit === null ? 'MB' : `of ${mb(r.memory.limit)} MB`}
            spark={r.memory.spark}
            title="memory.current, page cache included"
          />
        ),
    ),
    ...from.map(
      ({ key, label, r }) =>
        r.oomKills !== null &&
        r.oomKills > 0 && (
          <Stat
            key={`oom-${key}`}
            label={`${label} OOM kills`}
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

function BridgeBoard({
  title,
  bridge: w,
  version,
  foot,
}: {
  title: string
  bridge: BridgeStatus
  version: string | null
  foot: ReactNode
}) {
  const rows: Row[] = [
    { k: 'Bridge', v: w.ready ? 'ready' : <Chip tone="bad">not ready</Chip> },
    ...(version === null ? [] : [{ k: 'Version', v: <span className={MONO}>{version}</span> }]),
    ...(w.error === '' ? [] : [{ k: 'Asking it', v: <Chip tone="bad">{w.error}</Chip> }]),
    ...w.logins.flatMap(loginRows),
  ]
  const worst = w.logins.find((l) => stateOf(l.state).tone === 'bad')
  return (
    <Board
      title={title}
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
      <p className={FOOT}>{foot}</p>
    </Board>
  )
}

function LinkLinkedInBoard() {
  return (
    <Board title="Link LinkedIn" span={12}>
      <Facts
        rows={[
          {
            k: 'With your password',
            v: <span className={MONO}>matrix-linkedin-link password</span>,
          },
          {
            k: 'With a browser’s session',
            v: <span className={MONO}>matrix-linkedin-link cookies</span>,
          },
          { k: 'To log out', v: <span className={MONO}>matrix-linkedin-link logout</span> },
        ]}
      />
      <p className={FOOT}>
        From a terminal on the box; it asks for what LinkedIn needs and keeps none of it. With a
        password, the bridge signs in itself and LinkedIn may send a code or ask for approval in its
        app. With a session, paste one request copied from Chrome while signed in: DevTools,{' '}
        <b>Network</b>, any request to <span className={MONO}>www.linkedin.com/voyager/</span>,{' '}
        <b>Copy as cURL (bash)</b>.
      </p>
    </Board>
  )
}

function LinkWhatsAppBoard() {
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
