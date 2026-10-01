import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Facts, Measures, Progress, Pulse } from '../../../../components/viz'
import { bytes, DASH, num, rate, until } from '../../../../lib/format'
import {
  EMPTY,
  FOOT,
  NOTE,
  TRANSFER_HEAD,
  TRANSFER_META,
  TRANSFER_NAME,
  TRANSFER_ROW,
  TRANSFERS,
} from '../shared'
import type { Downloaders } from './shared'
import { TunnelBoard } from './shared'

export function QbtPage({ d }: { d: Downloaders }) {
  const { qbt } = d

  return (
    <>
      <ServiceHead
        logo="/icon-qbittorrent.svg"
        name="qBittorrent"
        version={qbt.version}
        versionNote="reported by the app"
        verdict={verdictOf(qbt.gap)}
        compare={compareOf(qbt.gap, 'from /api/v2/app/version')}
        lede={
          <>
            The torrent half, and what the *arrs reach for first. Runs inside gluetun&rsquo;s
            network namespace, so the forwarded port matters: without one it can download and never
            seed.
          </>
        }
        actions={<Open name="qBittorrent" host="qbittorrent" />}
      />

      <BoardGrid>
        <Board
          title="Transfers"
          icon="down"
          span={8}
          aside={
            <span className={NOTE}>
              <Pulse on={(qbt.down ?? 0) + (qbt.up ?? 0) > 0} tone="accent" />
              {qbt.connection ?? DASH}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'Down', v: rate(qbt.down) },
              { k: 'Up', v: rate(qbt.up) },
              { k: 'Session', v: `${bytes(qbt.sessionDown)} in · ${bytes(qbt.sessionUp)} out` },
              { k: 'Free', v: bytes(qbt.freeBytes) },
            ]}
          />
          {qbt.transfers.length === 0 ? (
            <p className={EMPTY}>
              {qbt.reachable
                ? 'Nothing downloading. Completed torrents are removed after import.'
                : 'qBittorrent did not accept the login.'}
            </p>
          ) : (
            <ul className={TRANSFERS}>
              {qbt.transfers.map((t) => (
                <li key={t.name} className={TRANSFER_ROW}>
                  <div className={TRANSFER_HEAD}>
                    <span className={TRANSFER_NAME} title={t.name}>
                      {t.name}
                    </span>
                    <span className={TRANSFER_META}>
                      {t.active && <>{rate(t.down)} · </>}
                      {t.pct.toFixed(0)}% of {bytes(t.size)}
                      {t.etaSeconds !== null && <> · {until(t.etaSeconds)} left</>}
                      {t.pct >= 100 && <> · ratio {t.ratio.toFixed(2)}</>}
                    </span>
                  </div>
                  <Progress pct={t.pct} tone={t.active ? 'accent' : 'muted'} active={t.active} />
                </li>
              ))}
            </ul>
          )}
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <Board title="The swarm" icon="⁘" span={4}>
          <Facts
            rows={[
              { k: 'Downloading', v: num(qbt.counts.leeching) },
              { k: 'Seeding', v: num(qbt.counts.seeding) },
              {
                k: 'Stalled',
                v:
                  qbt.counts.stalled === 0 ? (
                    num(0)
                  ) : (
                    <span className="text-warning">{num(qbt.counts.stalled)}</span>
                  ),
              },
              {
                k: 'Errored',
                v:
                  qbt.counts.errored === 0 ? (
                    num(0)
                  ) : (
                    <span className="text-danger">{num(qbt.counts.errored)}</span>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Stalled is the state that needs reading in context: with a forwarded port it usually
            means no seeders, and without one it means every torrent will end up here.
          </p>
        </Board>

        <Changelog gap={qbt.gap} span={8} aside={<span className={NOTE}>qbittorrent</span>} />

        <LogBoard source={{ container: 'qbittorrent' }} title="qBittorrent logs" />
      </BoardGrid>
    </>
  )
}
