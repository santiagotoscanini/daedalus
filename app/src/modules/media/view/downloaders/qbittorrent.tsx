import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { LIVE } from '../../../../components/tokens'
import { Board, BoardGrid, Facts, Measures, Pulse } from '../../../../components/viz'
import { bytes, DASH, num, rate, until } from '../../../../lib/format'
import { FOOT, NOTE, QueueTable, TableSection } from '../shared'
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
            The torrent half, and what the *arrs reach for first. It runs in gluetun&rsquo;s
            namespace: without a forwarded port it downloads and never seeds.
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
            <span className={LIVE}>
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
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <TableSection title="Torrents">
          <QueueTable
            label="Torrents"
            detail="Rate · size · time left"
            empty={
              qbt.reachable
                ? 'Nothing downloading. Completed torrents are removed after import.'
                : 'qBittorrent did not accept the login.'
            }
            rows={qbt.transfers.map((t) => ({
              key: t.name,
              name: t.name,
              pct: t.pct,
              tone: 'muted',
              active: t.active,
              detail: (
                <>
                  {t.active && <>{rate(t.down)} · </>}
                  {bytes(t.size)}
                  {t.etaSeconds !== null && <> · {until(t.etaSeconds)} left</>}
                  {t.pct >= 100 && <> · ratio {t.ratio.toFixed(2)}</>}
                </>
              ),
            }))}
          />
        </TableSection>

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
