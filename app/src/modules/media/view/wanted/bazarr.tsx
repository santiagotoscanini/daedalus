import { LogBoard, type LogNeighbour } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Facts } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, num } from '../../../../lib/format'
import { EMPTY, FOOT, MONO, NOTE, PROV, PROVS } from '../shared'
import type { Wanted } from './shared'

/* ── Bazarr — reached from the Wanted switch above ────────────────────── */

const BAZARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'subgen' },
    label: 'Subgen',
    role: 'Whisper, for the subtitles nobody published',
    note: 'Registered with Bazarr as the `whisperai` provider. When an episode has no subtitles anywhere, this transcribes the audio instead. It runs on the CPU, so a single film can take a long time and the only evidence it is working is here.',
  },
]

export function BazarrPage({ d }: { d: Wanted['bazarr'] }) {
  const throttled = d.providers.filter((p) => !p.ok)

  return (
    <>
      <ServiceHead
        logo="/icon-bazarr.svg"
        name="Bazarr"
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/system/status')}
        lede={
          <>
            Subtitles for what the others already downloaded. It reads Sonarr&rsquo;s and
            Radarr&rsquo;s libraries directly, so nothing here decides what exists, only what is
            missing words.
          </>
        }
        actions={<Open name="Bazarr" host="bazarr" />}
      />

      <BoardGrid>
        <Board
          title="Providers"
          icon="⛁"
          span={8}
          aside={
            throttled.length === 0 ? (
              <span className={NOTE}>all answering</span>
            ) : (
              <span className={cn(NOTE, 'text-warning')}>{num(throttled.length)} throttled</span>
            )
          }
        >
          {d.providers.length === 0 ? (
            <p className={EMPTY}>could not read the provider list</p>
          ) : (
            <ul className={PROVS}>
              {d.providers.map((p) => (
                <li key={p.name} className={PROV}>
                  <Chip tone={p.ok ? 'ok' : 'warn'}>{p.status}</Chip>
                  <span className={MONO}>{p.name}</span>
                  {p.retry !== '-' && (
                    <span className="text-[0.72rem] text-warning">retry {p.retry}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The panel that explains a subtitle which never arrives. A throttled provider answers
            nothing and reports no error, so &ldquo;none found&rdquo; and &ldquo;we are not
            currently allowed to ask&rdquo; look identical everywhere except here.
          </p>
        </Board>

        <Board title="Still missing" icon="clock" span={4}>
          <Facts
            rows={[
              { k: 'Episodes', v: num(d.wanted.episodes) },
              { k: 'Movies', v: num(d.wanted.movies) },
              { k: 'Sees Sonarr', v: <span className={MONO}>{d.linked.sonarr ?? DASH}</span> },
              { k: 'Sees Radarr', v: <span className={MONO}>{d.linked.radarr ?? DASH}</span> },
            ]}
          />
          <p className={FOOT}>
            The two versions are Bazarr&rsquo;s own view of the *arrs it is wired to. It is a cheap
            cross-check that both connections are live, since a broken one reports zero missing
            rather than an error.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.subgen === null ? (
              <span className={NOTE}>github</span>
            ) : (
              <span className={NOTE}>
                Subgen <span className={MONO}>{d.subgen}</span>
              </span>
            )
          }
        />

        <LogBoard
          source={{ container: 'bazarr' }}
          title="Bazarr logs"
          neighbours={BAZARR_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}
