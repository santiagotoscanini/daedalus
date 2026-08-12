import type { GamingData } from '../../lib/dashboard/categories/gaming'
import { LogBoard } from '../logs'
import { Changelog, ReleaseNotes, UpgradeChain } from '../release-notes'
import { ServiceHead } from '../service-head'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip } from '../viz'

// The Gaming page. Two servers, and the shape held.
//
// Both lead with the version rather than with uptime because that is the fact
// that actually breaks things here: a client on a different build cannot join
// at all, so "am I current" is the question. Whether it is up is answered by
// the dot on the sub-tab, one level up — see CategorySpec.tabs — except for
// Minecraft, which has no HTTP endpoint for a probe to read and so answers
// that question on its own page, from the game's own status ping.
//
// ── one number on the page, and its comparisons on demand ─────────────────
//
// The running build is the only version stated outright. What Wube calls
// stable and what it calls experimental are the numbers it is measured
// AGAINST, not facts about this server, and as headline cards they read as
// three unrelated versions competing for the same glance. They live behind
// the chip that summarises them instead: the chip already says the answer
// ("current"), and hovering it shows the working.

export function GamingView({ data }: { data: GamingData }) {
  if (data.tab === 'minecraft') return <MinecraftView data={data} />
  return <FactorioView data={data} />
}

/**
 * Paper, and the only tab here whose numbers are live.
 *
 * It leads with the same fact Factorio does — the version, because a client on
 * the wrong one cannot join — but everything under it comes from the server
 * itself, via the status ping. That is deliberate: the ping is part of the
 * protocol, so it keeps answering across version bumps, where every metrics
 * PLUGIN would have to be re-vetted on each one.
 *
 * "Answering" is therefore a stronger claim than the dot on a sub-tab
 * elsewhere on this dashboard. Those read a container; this read the game.
 */
function MinecraftView({ data }: { data: Extract<GamingData, { tab: 'minecraft' }> }) {
  const { minecraft: mc, builds, events } = data
  const behind = builds.behind.length
  // Being behind on BUILDS is routine — Paper cuts several a day. Being behind
  // on the game is the one that stops people joining, so it is the verdict.
  const stale = mc.latestVersion !== null && mc.version !== null && mc.latestVersion !== mc.version

  return (
    <>
      <ServiceHead
        logo="/icon-minecraft.svg"
        name="Minecraft"
        version={mc.version}
        versionNote={mc.build === null ? 'running' : `running · Paper build ${mc.build}`}
        verdict={
          mc.version === null
            ? { label: 'unknown', tone: 'muted' }
            : stale
              ? { label: 'behind a release', tone: 'warn' }
              : { label: 'current', tone: 'ok' }
        }
        compare={[
          {
            k: 'Latest release',
            v: mc.latestVersion,
            note: stale ? 'clients on this cannot join' : 'this is what is running',
          },
          {
            k: 'Server reports',
            v: mc.reported,
            note: 'what the ping handshake said — should echo the pin',
          },
        ]}
        lede={
          <>
            Paper, near-vanilla. Everyone connects to <span className="mono">{mc.connect}</span> —
            the same address at home and away, because pi-hole answers that name with the LAN
            address and Cloudflare with the public one.
          </>
        }
        actions={
          mc.healthy === null ? (
            <Chip tone="muted">not scraped</Chip>
          ) : mc.healthy ? (
            <Chip tone="ok">answering</Chip>
          ) : (
            <Chip tone="bad">not answering</Chip>
          )
        }
      />

      <StatStrip>
        <Stat
          label="Players"
          value={mc.players ?? '—'}
          sub={mc.maxPlayers === null ? undefined : `of ${String(mc.maxPlayers)}`}
          spark={mc.online}
        />
        <Stat
          label="Ping"
          value={mc.ping === null ? '—' : (mc.ping * 1000).toFixed(0)}
          unit="ms"
          // Not decoration: the status ping runs on the main thread, so this
          // climbing is the first cheap sign of tick pressure — visible here
          // before anyone in the room says the word lag.
          tone={mc.ping !== null && mc.ping > 1 ? 'warn' : undefined}
          title="Round trip of the server-list ping, which the main thread answers."
        />
        <Stat
          label="Paper builds"
          value={behind === 0 ? 'current' : behind}
          sub={behind === 0 ? 'nothing new' : 'commits behind'}
        />
      </StatStrip>

      <BoardGrid>
        <Changelog
          build={builds}
          span={6}
          aside={<span className="board-note">papermc</span>}
          foot={
            <p className="board-foot">
              Commits rather than releases: Paper cuts a build per handful of them, so the count
              means little and the subjects mean everything. Each links to the real commit — the
              server jar is downloaded fresh for this version and build on every start, so a bump
              here is a restart away.
            </p>
          }
        />

        <Board
          title="Comings and goings"
          icon="panels"
          span={6}
          aside={<span className="board-note">last 7 days</span>}
        >
          {events.length === 0 ? (
            <p className="viz-empty">nobody has joined this week</p>
          ) : (
            <ul className="news">
              {events.map((e) => (
                <li key={`${String(e.at)}-${e.who}`} className="news-row">
                  <Chip tone={e.kind === 'join' ? 'ok' : 'muted'}>
                    {e.kind === 'join' ? 'joined' : 'left'}
                  </Chip>
                  <span className="news-title">{e.who}</span>
                  <span className="news-date">
                    {new Date(e.at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* Read out of the server's own log rather than kept as a list here.
              The log already IS the record; a second one could only disagree
              with it. */}
          <p className="board-foot">
            Parsed from the server’s log in Loki, newest first. The panel below is the whole log,
            this is the part of it that is about people.
          </p>
        </Board>

        <Board title="How it is run" icon="⚒" span={12}>
          <Facts
            rows={[
              { k: 'Address', v: <span className="mono">{mc.connect}</span> },
              {
                k: 'Who gets in',
                v: 'Mojang session auth, plus an enforced whitelist pinned in nix',
              },
              {
                k: 'Ingress',
                v: 'TCP 25565 forwarded by the router — no tunnel: Minecraft offers no TLS, so traefik has no SNI to route on',
              },
              {
                k: 'World',
                v: 'its own ZFS dataset on NVMe, so it can be rolled back without taking every other stack with it',
              },
              {
                k: 'Backups',
                v: 'nightly RCON-quiesced archive to /s2, on top of 15-minute snapshots and the hourly replica',
              },
            ]}
          />
        </Board>

        <LogBoard source={{ container: 'minecraft' }} title="Minecraft logs" />
      </BoardGrid>
    </>
  )
}

function FactorioView({ data }: { data: Extract<GamingData, { tab: 'factorio' }> }) {
  const { factorio, news } = data
  const behind = factorio.behind.length
  const current = behind === 0 && factorio.installed !== null

  return (
    <>
      <ServiceHead
        logo="/icon-factorio.png"
        name="Factorio"
        version={factorio.installed}
        versionNote="running · re-downloaded on every start"
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
            note: 'not tracked — this server follows stable',
          },
        ]}
        lede={
          <>
            Headless server behind ofsm. Players connect to{' '}
            <span className="mono">{factorio.connect}</span> — the one UDP port the router forwards
            inward.
          </>
        }
        actions={
          <a className="btn btn-primary" href={factorio.adminUrl} target="_blank" rel="noreferrer">
            Open server manager ↗
          </a>
        }
      />

      <BoardGrid>
        <Board
          title={current ? 'Release notes' : `${String(behind)} to apply`}
          icon="logs"
          span={6}
          aside={<span className="board-note">wiki.factorio.com</span>}
        >
          {/* The chain lives here rather than in a panel of its own: when
              nothing is pending that panel was an empty box next to a full
              one, which is where the ragged column came from. */}
          <UpgradeChain behind={factorio.behind} />
          <ReleaseNotes releases={data.changelog} running={factorio.installed} />
          {/* These two captions sit side by side, so each says what it is
              rather than what logs are — and neither may claim the other's
              job. This one is the record of what changed. */}
          <p className="board-foot">
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
          aside={<span className="board-note">factorio.com/blog</span>}
        >
          {news.length === 0 ? (
            <p className="viz-empty">could not read the feed</p>
          ) : (
            <ul className="news">
              {news.map((n) => (
                <li key={n.url} className="news-row">
                  <Chip tone={n.kind === 'release' ? 'ok' : n.kind === 'fff' ? 'info' : 'muted'}>
                    {n.kind === 'release' ? 'release' : n.kind === 'fff' ? 'FFF' : 'post'}
                  </Chip>
                  <a href={n.url} target="_blank" rel="noreferrer" className="news-title">
                    {n.title}
                  </a>
                  <span className="news-date">{n.date}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Was "release posts are the changelog — there is no structured
              one", which was true when this panel stood alone and is now flatly
              contradicted by the structured changelog sitting next to it. */}
          <p className="board-foot">
            The studio’s own feed, which points forward: Friday Facts are what is being built rather
            than what has landed. What landed is the panel beside this one.
          </p>
        </Board>

        {/* Grafana itself rather than a log viewer of our own — see the note
            in components/logs.tsx and stacks/monitoring, which already allows
            this exact frame-ancestor. */}
        <LogBoard source={{ container: 'factorio' }} title="Factorio logs" />
      </BoardGrid>
    </>
  )
}
