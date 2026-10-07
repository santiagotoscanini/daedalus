import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, SOURCE_NOTE, verdictOf } from '../../../components/service-head'
import { FOOT, MONO, NOTE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../../../components/viz'
import { bytes, compact, DASH, ms, num } from '../../../lib/format'
import type { MonitoringData } from '../data'

// The Logs tab: Loki and the collector that fills it — volume, levels,
// coverage, and the shipping path that keeps talking when Loki goes quiet.

type Logs = Extract<MonitoringData, { tab: 'logs' }>

export function LogsView({ data: d }: { data: Logs }) {
  const f = logsFacts({ data: d })

  return (
    <>
      <ServiceHead
        logo="/icon-loki.svg"
        name="Loki"
        version={d.loki.version}
        versionNote="reported by /loki/api/v1/status/buildinfo"
        verdict={verdictOf(d.loki.gap)}
        compare={compareOf(d.loki.gap, 'from /loki/api/v1/status/buildinfo')}
        lede={
          <>
            Where every log panel on this dashboard gets its lines, including the one at the bottom
            of this page. Alloy tails journald and ships here; this stores and answers. It publishes
            no hostname of its own and is reached over the monitoring bridge, which is why this
            tab&rsquo;s dot is the one grey circle on the row: there is nothing here for gatus to
            probe from outside, which is a different claim from down.
          </>
        }
      />

      <BoardGrid>
        <VolumeBoard f={f} />

        <Board title="By level" icon="◱" span={4}>
          <BarList items={d.byLevel} empty="nothing labelled" />
        </Board>

        <Board title="Noisiest errors, 24h" icon="warn" span={4}>
          <BarList items={d.noisiest} empty="no errors" />
          <p className={FOOT}>
            Host journal lines carry <span className={MONO}>unit</span> rather than{' '}
            <span className={MONO}>container</span>, so they group together rather than appearing as
            a missing name.
          </p>
        </Board>

        <CoverageBoard f={f} />

        {/* The one board on this tab that does not read Loki — see the `ship`
            note in ../data/logs.ts: when shipping stops, everything
            above goes quiet with it, and this is what still talks. */}
        <ShippingBoard f={f} />

        {/* Two, because this tab has two subjects on two release cycles. The
          same shape the Downloaders and Cleanup tabs use for the services
          they hold side by side. */}
        <Changelog gap={d.loki.gap} span={6} aside={<span className={NOTE}>grafana/loki</span>} />
        <Changelog
          gap={d.alloy.gap}
          span={6}
          aside={<span className={NOTE}>grafana/alloy · {d.alloy.running.version ?? DASH}</span>}
          foot={
            <p className={FOOT}>
              The collector, on its own release cycle. Its version is read{' '}
              {SOURCE_NOTE[d.alloy.running.source]} rather than from the process: alloy shares a
              stack with Loki here and publishes no hostname, so there is nothing to ask.
            </p>
          }
        />

        <LokiLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function logsFacts({ data: d }: { data: Logs }) {
  return { d }
}

type LogsFacts = NonNullable<ReturnType<typeof logsFacts>>

function VolumeBoard({ f }: { f: LogsFacts }) {
  const { d } = f
  return (
    <Board
      title="Volume"
      icon="logs"
      span={8}
      aside={<span className={NOTE}>{compact(d.lines1h)} lines in the last hour</span>}
    >
      <Trend values={d.volumeHistory} height={90} />
      <h4 className={SUB}>Errors only, same day</h4>
      <Trend values={d.errorHistory} tone="bad" height={70} />
      <Measures
        items={[
          { k: 'lines 1h', v: compact(d.lines1h) },
          { k: 'ingest', v: `${bytes(d.ingestRate)}/s` },
        ]}
      />
      <p className={FOOT}>
        Two lines rather than one chart: total volume moves with how busy the box is and says
        nothing on its own, while the error line is the one worth reading. A spike in the second
        without a spike in the first is a service failing rather than a service working hard.
      </p>
    </Board>
  )
}

function CoverageBoard({ f }: { f: LogsFacts }) {
  const { d } = f
  return (
    <Board
      title="Coverage"
      icon="▣"
      span={8}
      aside={
        d.unregistered !== null && d.unregistered > 0 ? (
          <Chip tone="warn">{compact(d.unregistered)} unlabelled</Chip>
        ) : (
          <span className={NOTE}>all labelled</span>
        )
      }
    >
      <BarList items={d.byStack} empty="no stack labels" />
      <p className={FOOT}>
        Every container&rsquo;s lines are labelled with the stack it belongs to, generated from{' '}
        <span className={MONO}>fleet.logStacks</span>; an unregistered container falls back to its
        own name. The <span className={MONO}>adhoc</span> bucket is the one worth watching: it
        catches containers started by hand rather than by a unit, which once minted 77 phantom
        services in Loki before it existed.
      </p>
    </Board>
  )
}

function ShippingBoard({ f }: { f: LogsFacts }) {
  const { d } = f
  return (
    <Board title="Shipping" icon="⇥" span={4} aside={<span className={NOTE}>alloy → loki</span>}>
      <Facts
        rows={[
          {
            k: 'Ship lag, 10m mean',
            v: ms(d.ship.lagSeconds === null ? null : d.ship.lagSeconds * 1000),
          },
          {
            k: 'Journal read',
            v: d.ship.journalPerSec === null ? DASH : `${num(d.ship.journalPerSec, 1)} lines/s`,
          },
          {
            k: 'Filtered as noise',
            v: d.ship.filteredPerSec === null ? DASH : `${num(d.ship.filteredPerSec, 1)} lines/s`,
          },
          {
            k: 'Shipped',
            v: d.ship.sentPerSec === null ? DASH : `${num(d.ship.sentPerSec, 1)} lines/s`,
          },
          {
            k: 'Dropped, 24h',
            v:
              d.ship.dropped24h === null ? (
                DASH
              ) : d.ship.dropped24h > 0 ? (
                <span className="text-warning">{num(d.ship.dropped24h)}</span>
              ) : (
                'none'
              ),
          },
          {
            k: 'Push retries, 24h',
            v:
              d.ship.retries24h === null ? (
                DASH
              ) : d.ship.retries24h > 0 ? (
                <span className="text-warning">{num(d.ship.retries24h)}</span>
              ) : (
                'none'
              ),
          },
          {
            k: 'Config reload',
            v:
              d.ship.configOk === null ? (
                DASH
              ) : d.ship.configOk ? (
                'loaded'
              ) : (
                <Chip tone="bad">failed — running old rules</Chip>
              ),
          },
        ]}
      />
      <p className={FOOT}>
        The write path, from alloy&rsquo;s own scraped metrics rather than from Loki. These are the
        only numbers here that keep talking when shipping stops. Read minus filtered is shipped: the
        gap is <span className={MONO}>stacks/logging</span>&rsquo;s deliberate noise-drop stages,
        not loss. Loss is the <b>dropped</b> row. Lag includes journald&rsquo;s batching, so about a
        second standing is normal; a retry is Loki pushing back and the batch trying again.
      </p>
    </Board>
  )
}

function LokiLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'loki' }}
      title="Loki logs"
      neighbours={[
        {
          source: { container: 'alloy' },
          label: 'Alloy',
          role: 'the collector that fills it',
          note: 'Tails journald, applies the relabel rules generated from fleet.logStacks, and pushes to Loki. This is the half that touches the journal, so “lines stopped arriving” is answered here rather than next door. A rejected push, a dropped stream or a relabel rule that stopped matching all appear in this log and in no other.',
        },
      ]}
      foot={
        <p className={FOOT}>
          Loki&rsquo;s own stream, with the collector one disclosure below it. They were one panel
          under the shared <span className={MONO}>stack=logging</span> label, which interleaved two
          services whose failures mean opposite things. Loki refuses a query longer than about
          thirty days: a wider range on any log panel in this dashboard returns an error rather than
          fewer results.
        </p>
      }
    />
  )
}
