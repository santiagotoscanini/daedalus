import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Measures } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import { EMPTY, FEED, FEED_EVENT, FEED_ROW, FEED_TITLE, FOOT, NOTE } from '../shared'
import type { Downloaders } from './shared'

export function MetubePage({ d }: { d: Downloaders['metube'] }) {
  return (
    <>
      <ServiceHead
        logo="/icon-metube.svg"
        name="MeTube"
        version={d.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag, since MeTube serves no version')}
        lede={
          <>
            yt-dlp with a web form in front of it, and the only downloader here that nothing else
            drives: you point it at a URL yourself. Also inside the VPN namespace, which is
            occasionally why a site refuses it.
          </>
        }
        actions={<Open name="MeTube" host="metube" />}
      />

      <BoardGrid>
        <Board
          title="Queue"
          icon="down"
          span={8}
          aside={
            <span className={NOTE}>
              {num(d.queued)} queued · {num(d.pending)} pending
            </span>
          }
        >
          {d.recent.length === 0 ? (
            <p className={EMPTY}>Nothing downloaded yet.</p>
          ) : (
            <ul className={FEED}>
              {d.recent.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className={FEED_ROW}>
                  <span className={cn(FEED_EVENT, r.status !== 'finished' && 'text-danger')}>
                    {r.status}
                  </span>
                  <span className={FEED_TITLE} title={r.title}>
                    {r.title}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The most recent finished items. MeTube keeps its history in the browser session as well
            as on the server, so this list and the one in its own UI can differ.
          </p>
        </Board>

        <Board title="All time" icon="grid" span={4}>
          <Measures
            items={[
              { k: 'Completed', v: num(d.done) },
              { k: 'Queued', v: num(d.queued) },
              { k: 'Pending', v: num(d.pending) },
            ]}
          />
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className={FOOT}>
              MeTube ships a new dated build most weeks and almost all of them are a yt-dlp bump,
              which is what fixes a site that suddenly stopped downloading. It is the one service on
              this page where being behind is usually the whole explanation.
            </p>
          }
        />

        <LogBoard source={{ container: 'metube' }} title="MeTube logs" />
      </BoardGrid>
    </>
  )
}
