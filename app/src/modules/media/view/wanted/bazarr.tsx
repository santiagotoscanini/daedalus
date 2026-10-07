import { LogBoard, type LogNeighbour } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Facts } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { DASH, num } from '../../../../lib/format'
import {
  CELL_QUIET,
  FOOT,
  MONO,
  NOTE,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from '../shared'
import type { Wanted } from './shared'

/* Provider, its status, when it may be asked again. */
const PROV_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]',
)

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
            Subtitles for what the others downloaded. It reads Sonarr&rsquo;s and Radarr&rsquo;s
            libraries directly: it decides only what is missing words, never what exists.
          </>
        }
        actions={<Open name="Bazarr" host="bazarr" />}
      />

      <BoardGrid>
        <TableSection
          title="Providers"
          note={
            throttled.length === 0 ? (
              'all answering'
            ) : (
              <span className="text-warning">{num(throttled.length)} throttled</span>
            )
          }
          foot={
            <p className={FOOT}>
              The table that explains a subtitle which never arrives. A throttled provider answers
              nothing and reports no error, so &ldquo;none found&rdquo; and &ldquo;we are not
              currently allowed to ask&rdquo; look identical everywhere except here.
            </p>
          }
        >
          <ul className={TABLE} aria-label="Subtitle providers">
            {d.providers.length > 0 && (
              <li aria-hidden="true" className={cn(PROV_GRID, TABLE_HEAD)}>
                <span>Provider</span>
                <span>Status</span>
                <span className="text-right">Retry</span>
              </li>
            )}
            {d.providers.length === 0 ? (
              <li className={TABLE_EMPTY}>Could not read the provider list.</li>
            ) : (
              d.providers.map((p) => (
                <li key={p.name} className={cn(PROV_GRID, TABLE_ROW)}>
                  <span className="text-foreground">{p.name}</span>
                  {/* Answering is the norm: quiet. Throttled is the row to read. */}
                  <span>
                    {p.ok ? (
                      <span className={CELL_QUIET}>{p.status}</span>
                    ) : (
                      <Chip tone="warn">{p.status}</Chip>
                    )}
                  </span>
                  <span className={cn(CELL_QUIET, 'text-right', p.retry !== '-' && 'text-warning')}>
                    {p.retry === '-' ? '' : p.retry}
                  </span>
                </li>
              ))
            )}
          </ul>
        </TableSection>

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
          span={8}
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
