import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Trend } from '../../../components/viz'
import { bytes, compact, DASH, num } from '../../../lib/format'
import type { MonitoringData } from '../data'
import { LIST, MAIN, SCRAPE_NEIGHBOURS, SIDE } from './shared'

// The Metrics tab: prometheus — the targets not reporting and why, its storage
// and reach, the series trend and the slowest scrapes.

type Metrics = Extract<MonitoringData, { tab: 'metrics' }>

export function MetricsView({ data: d }: { data: Metrics }) {
  return (
    <>
      <ServiceHead
        logo="/icon-prometheus.svg"
        name="Prometheus"
        version={d.version}
        versionNote="reported by /api/v1/status/buildinfo"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/status/buildinfo')}
        lede={
          <>
            Every number on this dashboard that is a rate, a trend or a seven-day anything came from
            here. It publishes no host port and runs without{' '}
            <span className={MONO}>--web.enable-lifecycle</span>, and its scrape list is generated
            from nix. Each stack contributes its own{' '}
            <span className={MONO}>fleet.prometheusScrapes</span>, so a target that is missing is a
            stack that never declared one rather than a file somebody forgot to edit.
          </>
        }
        actions={<Open name="Prometheus" host="prometheus" />}
      />

      <BoardGrid>
        <Board
          title={d.down.length === 0 ? 'Every target reporting' : 'Targets not reporting'}
          icon="◉"
          span={8}
          aside={
            <span className={NOTE}>
              {num(d.targetsUp)} up · {num(d.targetsDown)} down
            </span>
          }
        >
          {d.down.length === 0 ? (
            <p className={EMPTY}>All {num(d.targetsUp)} scrape targets answered.</p>
          ) : (
            <ul className={LIST}>
              {d.down.map((t) => (
                <li key={`${t.job}-${t.instance}`}>
                  <Chip tone="bad">{t.job}</Chip>
                  <span className={`${MAIN} ${MONO}`}>{t.instance}</span>
                  <span className={SIDE}>{t.error}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Read from prometheus&rsquo;s own API rather than from{' '}
            <span className={MONO}>up == 0</span>, because only the API carries the last error: the
            difference between &ldquo;prometheus cannot reach this&rdquo; and &ldquo;this answered
            401&rdquo;. Both look like a dead target on a graph.
          </p>
        </Board>

        <Board title="Storage" icon="grid" span={4}>
          <Facts
            rows={[
              { k: 'Series in head', v: compact(d.series) },
              // compact, not `rate` — that formatter is BYTES per second, and a
              // sample count wearing a KB suffix is a wrong number, not a wrong
              // unit.
              {
                k: 'Samples/sec',
                v: d.samplesPerSec === null ? DASH : `${compact(d.samplesPerSec)}/s`,
              },
              { k: 'On disk', v: bytes(d.storageBytes) },
              {
                k: 'Retention',
                v: d.retention.days === null ? DASH : `${num(d.retention.days)} days`,
              },
              {
                k: 'Oldest sample',
                v:
                  d.retention.oldestDays === null
                    ? DASH
                    : `${num(d.retention.oldestDays)} days back`,
              },
            ]}
          />
          <p className={FOOT}>
            The two retention rows are the reading: if the oldest sample is well short of the
            window, the disk cap bit before the time limit did and the history is shorter than
            configured.
          </p>
        </Board>

        <Board title="Series, seven days" icon="panels" span={8}>
          <Trend values={d.seriesTrend} tone="accent" height={110} />
          <p className={FOOT}>
            Active series is what memory here is spent on. A step up that never comes back down is a
            new label with unbounded values. That is how a TSDB usually gets into trouble, and a
            total sample count would not show it.
          </p>
        </Board>

        <Board title="Slowest scrapes" icon="⏱" span={4}>
          <BarList items={d.slowestScrapes} tone="warn" empty="nothing measured" />
          <p className={FOOT}>
            A scrape that approaches its interval is a target about to start missing samples.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'prometheus' }}
          title="Prometheus logs"
          neighbours={SCRAPE_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}
