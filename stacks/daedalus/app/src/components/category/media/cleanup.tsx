import { useState } from 'react'
import type { MediaData } from '../../../lib/dashboard/categories/media'
import { num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import {
  compareOf,
  freshnessRow,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../service-head'
import { Board, BoardGrid, Chip, Measures } from '../../viz'
import { ServiceBar, tone, VERSION_SNAPSHOT } from './shared'

/* ── Cleanup: Cleanuparr, Janitorr ────────────────────────────────────── */

type Cleanup = Extract<MediaData, { tab: 'cleanup' }>

export function CleanupView({ d }: { d: Cleanup }) {
  const [which, setWhich] = useState<'cleanuparr' | 'janitorr'>('cleanuparr')

  return (
    <>
      <ServiceBar
        value={which}
        onChange={setWhich}
        options={[
          { value: 'cleanuparr', label: 'Cleanuparr', dot: tone(d.cleanuparr.removed !== null) },
          // Whether it has SPOKEN in the last day, not whether we know its
          // version. That used to be the same test by accident — the version
          // came from a startup line in the log — and it stopped meaning
          // anything the moment the version started coming from the image,
          // which is present whether or not the container ever runs. Janitorr
          // announces its schedules hourly, so silence for a day is the signal.
          { value: 'janitorr', label: 'Janitorr', dot: tone(d.janitorr.schedules.length > 0) },
        ]}
      />

      {which === 'cleanuparr' ? <CleanuparrPage d={d} /> : <JanitorrPage d={d} />}
    </>
  )
}

function CleanuparrPage({ d }: { d: Cleanup }) {
  const { cleanuparr } = d
  const window = `last ${String(d.days)} days`

  return (
    <>
      <ServiceHead
        logo="/icon-cleanuparr.png"
        name="Cleanuparr"
        version={cleanuparr.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(cleanuparr.gap)}
        compare={compareOf(cleanuparr.gap, 'the image tag — the API that reported it is closed')}
        lede={
          <>
            Unsticks the download queues: strikes items that stop progressing, blocks the ones that
            keep coming back, and asks the *arr for a replacement. It is why the queues on the
            Wanted tab are usually empty rather than full of dead entries.
          </>
        }
        actions={<Open name="Cleanuparr" host="cleanuparr" />}
      />

      <BoardGrid>
        <Board
          title="What it did"
          icon="⌫"
          span={8}
          aside={<span className="board-note">{window}</span>}
        >
          <Measures
            items={[
              { k: 'Stuck items removed', v: num(cleanuparr.removed) },
              {
                k: 'Blocked (kept returning)',
                v: num(cleanuparr.blocked),
                tone: (cleanuparr.blocked ?? 0) > 0 ? 'warn' : undefined,
              },
              { k: 'Replacement searches', v: num(cleanuparr.searches) },
            ]}
          />
          <p className="board-foot">
            Counted out of its own log lines in Loki. Cleanuparr publishes no metrics and 2.10.1
            closed the API that used to report this, so these three phrases are the interface.
          </p>
        </Board>

        <Board title="Why it is here" icon="◈" span={4}>
          <p className="board-foot">
            A download that stalls does not fail — it sits in the queue at 97% forever, and the *arr
            goes on believing the episode is handled. Nothing else on this box notices that.
            Cleanuparr strikes it, removes it, blocks the release and asks for another one.
          </p>
        </Board>

        <Changelog gap={cleanuparr.gap} span={12} />

        <LogBoard source={{ container: 'cleanuparr' }} title="Cleanuparr logs" />
      </BoardGrid>
    </>
  )
}

function JanitorrPage({ d }: { d: Cleanup }) {
  const { janitorr } = d
  const armed = janitorr.schedules.filter((s) => s.enabled).length

  return (
    <>
      <ServiceHead
        logo="/icon-janitorr.png"
        name="Janitorr"
        version={janitorr.running.version}
        versionNote={SOURCE_NOTE[janitorr.running.source]}
        verdict={verdictOf(janitorr.gap, janitorr.freshness)}
        compare={[
          ...compareOf(
            janitorr.gap,
            janitorr.running.revision === null
              ? 'the image’s OCI label — the tag is a channel'
              : `the image’s OCI label · built from ${janitorr.running.revision}`,
          ),
          ...freshnessRow(janitorr.freshness),
        ]}
        lede={
          <>
            Retention: deletes what nobody has watched, on a schedule. Running in dry-run, so it
            decides and then does nothing — which makes its log the whole of its output.
          </>
        }
        actions={
          <Chip tone={armed === 0 ? 'muted' : 'warn'}>
            {armed === 0 ? 'dry-run' : `${String(armed)} armed`}
          </Chip>
        }
      />

      <BoardGrid>
        <Board
          title="Schedules"
          icon="clock"
          span={8}
          aside={<span className="board-note">as it reports them hourly</span>}
        >
          {janitorr.schedules.length === 0 ? (
            <p className="viz-empty">nothing in the last day&rsquo;s log</p>
          ) : (
            <ul className="provs">
              {janitorr.schedules.map((s) => (
                <li key={s.name} className="prov">
                  <Chip tone={s.enabled ? 'warn' : 'muted'}>{s.enabled ? 'enabled' : 'off'}</Chip>
                  <span className="prov-name">{s.name} based cleanup</span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            The schedules that announce themselves — every hour, whether or not they do anything.
            Off here is what a deliberately disarmed retention service looks like, and without this
            panel it is indistinguishable from a broken one. It is not a list of everything Janitorr
            can do: its media-based cleanup says nothing either way on this box, which is why the
            count beside this one is the backstop.
          </p>
        </Board>

        <Board title="Would delete" icon="⌦" span={4}>
          <Measures items={[{ k: `Last ${String(d.days)} days`, v: num(janitorr.wouldDelete) }]} />
          <p className="board-foot">
            Dry-run — nothing is removed, so this is what it decided it would take if it were armed.
            The image is pinned to a moving <span className="mono">jvm-stable</span>, which carries
            no version; the one in the header comes from the image&rsquo;s own OCI label.
          </p>
        </Board>

        <Changelog
          gap={janitorr.gap}
          span={12}
          aside={<span className="board-note">Schaka/janitorr</span>}
        />

        <LogBoard
          source={{ container: 'janitorr' }}
          title="Janitorr logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
