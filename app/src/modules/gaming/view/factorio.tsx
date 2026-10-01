import { DAY_TIME, LocalTime } from '../../../components/ago'
import { LogBoard } from '../../../components/logs'
import { ReleaseNotes, UpgradeChain } from '../../../components/release-notes'
import { ServiceHead } from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Stat, StatStrip } from '../../../components/viz'
import type { GamingData } from '../data'
import { NEWS, NEWS_DATE, NEWS_ROW, NEWS_TITLE } from './shared'

/**
 * Live only at second hand — see `FactorioData['live']` in data/factorio.ts.
 * No player count, because RCON never leaves ofsm's netns; the stat strip
 * carries what the log and the container gauge can honestly say.
 */
export function FactorioView({ data }: { data: Extract<GamingData, { tab: 'factorio' }> }) {
  const { factorio, news, live, events } = data
  const behind = factorio.behind.length
  const current = behind === 0 && factorio.installed !== null

  return (
    <>
      <ServiceHead
        logo="/icon-factorio.png"
        name="Factorio"
        version={factorio.installed}
        versionNote="running, re-downloaded on every start"
        verdict={
          current
            ? { label: 'current', tone: 'ok' }
            : { label: `${String(behind)} behind`, tone: 'warn' }
        }
        compare={[
          {
            k: 'Stable',
            v: factorio.stable,
            note: current ? 'this is what is running' : 'what this server should be on',
          },
          {
            k: 'Experimental',
            v: factorio.experimental,
            note: 'not tracked, since this server follows stable',
          },
        ]}
        lede={
          <>
            Headless server behind ofsm. Players connect to{' '}
            <span className={MONO}>{factorio.connect}</span>, the one UDP port the router forwards
            inward.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href={factorio.adminUrl} target="_blank" rel="noreferrer">
              Open server manager ↗
            </a>
          </Button>
        }
      />

      <StatStrip>
        <Stat
          label="Game process"
          value={live.game === null ? '—' : live.game}
          tone={live.game === 'stopped' ? 'warn' : undefined}
          sub={
            live.since === null ? (
              'nothing in the log for 30 days'
            ) : (
              <>
                since <LocalTime at={live.since} opts={DAY_TIME} />
              </>
            )
          }
          title="The newest start/stop line in the server’s own log. The manager keeps running either way."
        />
        <Stat
          label="Manager"
          value={live.containerUp === null ? '—' : live.containerUp ? 'up' : 'down'}
          tone={live.containerUp === false ? 'bad' : undefined}
          sub="the ofsm container"
        />
        {/* A count computed from an empty log and one computed from an
            unreachable Loki are the same array — only claim zero when the
            same query proved it could read the stream at all. */}
        <Stat
          label="Joins"
          value={
            events.length === 0 && live.game === null
              ? '—'
              : events.filter((e) => e.kind === 'join').length
          }
          sub="last 30 days"
        />
      </StatStrip>

      <BoardGrid>
        <Board
          title={current ? 'Release notes' : `${String(behind)} to apply`}
          icon="logs"
          span={6}
          aside={<span className={NOTE}>wiki.factorio.com</span>}
        >
          {/* The chain lives here rather than in a panel of its own, which
              would sit empty beside this one whenever nothing is pending. */}
          <UpgradeChain behind={factorio.behind} />
          <ReleaseNotes releases={data.changelog} running={factorio.installed} />
          {/* These two captions sit side by side, so each says what it is
              rather than what logs are — and neither may claim the other's
              job. This one is the record of what changed. */}
          <p className={FOOT}>
            {current
              ? 'What the running build shipped, '
              : 'Everything between the running build and stable, '}
            parsed from the wiki’s page source. Open one for the fixes; the link inside goes to the
            full section.
          </p>
        </Board>

        <Board
          title="From the devs"
          icon="panels"
          span={6}
          aside={<span className={NOTE}>factorio.com/blog</span>}
        >
          {news.length === 0 ? (
            <p className={EMPTY}>could not read the feed</p>
          ) : (
            <ul className={NEWS}>
              {news.map((n) => (
                <li key={n.url} className={NEWS_ROW}>
                  <Chip tone={n.kind === 'release' ? 'ok' : n.kind === 'fff' ? 'info' : 'muted'}>
                    {n.kind === 'release' ? 'release' : n.kind === 'fff' ? 'FFF' : 'post'}
                  </Chip>
                  <a href={n.url} target="_blank" rel="noreferrer" className={NEWS_TITLE}>
                    {n.title}
                  </a>
                  <span className={NEWS_DATE}>{n.date}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Not "release posts are the changelog": the structured changelog
              is the panel beside this one. */}
          <p className={FOOT}>
            The studio’s own feed, which points forward: Friday Facts are about what is being built.
            What has landed is the panel beside this one.
          </p>
        </Board>

        <Board
          title="Comings and goings"
          icon="panels"
          span={12}
          aside={<span className={NOTE}>last 30 days</span>}
        >
          {events.length === 0 ? (
            <p className={EMPTY}>nobody has joined this month</p>
          ) : (
            <ul className={NEWS}>
              {events.map((e) => (
                <li key={`${String(e.at)}-${e.who}-${e.kind}`} className={NEWS_ROW}>
                  <Chip tone={e.kind === 'join' ? 'ok' : 'muted'}>
                    {e.kind === 'join' ? 'joined' : 'left'}
                  </Chip>
                  <span className={NEWS_TITLE}>{e.who}</span>
                  <span className={NEWS_DATE}>
                    <LocalTime at={e.at} opts={DAY_TIME} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* Read from the log, as on Minecraft — see gameLines in data/factorio.ts. */}
          <p className={FOOT}>
            Parsed from the server’s log in Loki, newest first: the game announces every arrival and
            departure with a <span className={MONO}>[JOIN]</span>/
            <span className={MONO}>[LEAVE]</span> line. The panel below is the whole log; this is
            the part about people.
          </p>
        </Board>

        {/* Grafana itself rather than a log viewer of our own — see the note
            in components/logs.tsx; nix/modules/monitoring allows this
            frame-ancestor. */}
        <LogBoard source={{ container: 'factorio' }} title="Factorio logs" />
      </BoardGrid>
    </>
  )
}
