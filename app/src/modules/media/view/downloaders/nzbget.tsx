import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import {
  Board,
  BoardGrid,
  Chip,
  Facts,
  Measures,
  Progress,
  Pulse,
} from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { bytes, num, rate, since } from '../../../../lib/format'
import {
  EMPTY,
  FOOT,
  MONO,
  NOTE,
  PROV,
  PROVS,
  TRANSFER_HEAD,
  TRANSFER_META,
  TRANSFER_NAME,
  TRANSFER_ROW,
  TRANSFERS,
} from '../shared'
import type { Downloaders } from './shared'
import { TunnelBoard } from './shared'

export function NzbPage({ d }: { d: Downloaders }) {
  const { nzb } = d
  const inactive = nzb.servers.filter((s) => !s.active).length
  const total = nzb.freeBytes

  return (
    <>
      <ServiceHead
        logo="/icon-nzbget.svg"
        name="NZBGet"
        version={nzb.version}
        versionNote="reported by the app"
        verdict={verdictOf(nzb.gap)}
        compare={compareOf(nzb.gap, 'from /jsonrpc/version')}
        lede={
          <>
            The usenet half. Faster than a torrent when the post is fully retained and useless when
            it is not. Retention is a property of the provider rather than the release, which is why
            the news-server list is on this page.
          </>
        }
        actions={<Open name="NZBGet" host="nzbget" />}
      />

      <BoardGrid>
        <Board
          title="Downloading"
          icon="down"
          span={8}
          aside={
            <span className={NOTE}>
              <Pulse on={(nzb.rate ?? 0) > 0} tone="accent" />
              {nzb.paused ? 'paused' : nzb.standby ? 'idle' : 'active'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'Rate', v: rate(nzb.rate) },
              { k: 'Remaining', v: bytes(nzb.remainingBytes) },
              { k: 'Today', v: bytes(nzb.dayBytes) },
              { k: 'This month', v: bytes(nzb.monthBytes) },
            ]}
          />
          {nzb.groups.length === 0 ? (
            <p className={EMPTY}>Nothing in the queue.</p>
          ) : (
            <ul className={TRANSFERS}>
              {nzb.groups.map((g) => (
                <li key={g.name} className={TRANSFER_ROW}>
                  <div className={TRANSFER_HEAD}>
                    <span className={TRANSFER_NAME} title={g.name}>
                      {g.name}
                    </span>
                    <span className={TRANSFER_META}>
                      {g.pct.toFixed(0)}% · {bytes(g.remainingBytes)} left
                    </span>
                  </div>
                  <Progress pct={g.pct} tone="info" active={!nzb.paused} />
                </li>
              ))}
            </ul>
          )}
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <Board
          title="News servers"
          icon="⛁"
          span={4}
          aside={
            inactive === 0 ? (
              <span className={NOTE}>all active</span>
            ) : (
              <span className={cn(NOTE, 'text-danger')}>{num(inactive)} inactive</span>
            )
          }
        >
          {nzb.servers.length === 0 ? (
            <p className={EMPTY}>could not read the server list</p>
          ) : (
            <ul className={PROVS}>
              {nzb.servers.map((s) => (
                <li key={s.id} className={PROV}>
                  <Chip tone={s.active ? 'ok' : 'bad'}>{s.active ? 'active' : 'inactive'}</Chip>
                  <span className={MONO}>server {s.id}</span>
                </li>
              ))}
            </ul>
          )}
          <Facts
            rows={[
              { k: 'Uptime', v: since(nzb.uptimeSeconds) },
              { k: 'Spent downloading', v: since(nzb.downloadSeconds) },
              { k: 'Free where it writes', v: bytes(total) },
            ]}
          />
          <p className={FOOT}>
            A provider whose subscription lapses goes inactive and everything stops being found.
            From Sonarr&rsquo;s side that is indistinguishable from the release not existing.
          </p>
        </Board>

        <Changelog gap={nzb.gap} span={8} aside={<span className={NOTE}>nzbgetcom/nzbget</span>} />

        <LogBoard source={{ container: 'nzbget' }} title="NZBGet logs" />
      </BoardGrid>
    </>
  )
}
