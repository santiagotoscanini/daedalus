import { Board, Facts, Pulse } from '../../../../components/viz'
import { flag } from '../../../../lib/format'
import type { MediaData } from '../../data'
import { FOOT, MONO } from '../shared'

export type Downloaders = Extract<MediaData, { tab: 'downloaders' }>

/** The tunnel, as three facts rather than a panel — see `DownloadsData.vpn`. */
export function TunnelBoard({ vpn, span }: { vpn: Downloaders['vpn']; span: 4 | 6 }) {
  return (
    <Board title="The tunnel" icon="⛨" span={span}>
      <div className="flex items-center gap-[0.5rem] text-[0.95rem]">
        <Pulse on={vpn.up === true} tone={vpn.up === true ? 'ok' : 'bad'} />
        <strong>{vpn.up === null ? 'unknown' : vpn.up ? 'connected' : 'down'}</strong>
      </div>
      <Facts
        rows={[
          { k: 'Exit', v: flag(vpn.country) },
          {
            k: 'Forwarded port',
            v:
              vpn.port === null ? (
                <span className="text-danger">not forwarded</span>
              ) : (
                <span className={MONO}>{vpn.port}</span>
              ),
          },
        ]}
      />
      <p className={FOOT}>
        Every downloader on this tab shares gluetun&rsquo;s network namespace, so every byte crossed
        this tunnel. The full picture is on Network › Going out; what is here is what changes the
        meaning of the panels beside it.
      </p>
    </Board>
  )
}
