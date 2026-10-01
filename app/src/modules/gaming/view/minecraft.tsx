import { DAY_TIME, LocalTime } from '../../../components/ago'
import { ImageRow } from '../../../components/image-row'
import { LogBoard } from '../../../components/logs'
import { Changelog, ReleaseNotes } from '../../../components/release-notes'
import { ServiceHead } from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip } from '../../../components/viz'
import type { GamingData } from '../data'
import { VersionBoard } from './minecraft-update'
import { RosterBoard } from './roster'
import { NEWS, NEWS_DATE, NEWS_ROW, NEWS_TITLE } from './shared'

/**
 * Paper, and the only tab here whose numbers are live.
 *
 * It leads with the same fact Factorio does — the version, because a client on
 * the wrong one cannot join — but everything under it comes from the server
 * itself, via the status ping. That is deliberate: the ping is part of the
 * protocol, so it keeps answering across version bumps, where every metrics
 * PLUGIN would have to be re-vetted on each one.
 *
 * "Answering" is therefore a stronger claim than the dot on most tabs, which
 * reads an HTTP probe; this one reads the game.
 */
export function MinecraftView({ data }: { data: Extract<GamingData, { tab: 'minecraft' }> }) {
  const f = minecraftFacts({ data })
  const { mc, builds, roster, behind, stale } = f

  return (
    <>
      <ServiceHead
        logo="/icon-minecraft.svg"
        name="Minecraft"
        version={mc.version}
        versionNote={mc.build === null ? 'running' : `running Paper build ${mc.build}`}
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
            note: 'what the ping handshake said, which should echo the pin',
          },
        ]}
        lede={
          <>
            Paper, near-vanilla. Everyone connects to <span className={MONO}>{mc.connect}</span>.
            That works at home and away because pi-hole answers the name with the LAN address and
            Cloudflare with the public one.
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
        <VersionBoard
          version={mc.version}
          build={mc.build}
          latest={mc.latestVersion}
          players={mc.players}
          update={data.update}
          initialStatus={data.versionStatus}
        />

        <Panel f={f} />

        {data.update.commits.behind.length > 0 && (
          <Changelog
            build={data.update.commits}
            span={6}
            title={`Paper for ${data.update.options.find((o) => o.newGame)?.version ?? 'the next game'}`}
            aside={<span className={NOTE}>papermc</span>}
            foot={
              <p className={FOOT}>
                The newest fifteen commits in Paper's builds for the newer game, newest last, each
                prefixed with its build. What is still landing is the best read of how ready it is.
              </p>
            }
          />
        )}

        <RosterBoard rows={roster} />

        <Changelog
          build={builds}
          span={6}
          aside={<span className={NOTE}>papermc</span>}
          foot={
            <p className={FOOT}>
              Commits rather than releases: Paper cuts a build per handful of them, so the subjects
              matter more than the count. Each links to the real commit. The server jar is
              downloaded fresh for this version and build on every start, so a bump here is a
              restart away.
            </p>
          }
        />

        <ComingsAndGoingsBoard f={f} />

        <HowItIsRunBoard f={f} />

        <ContainersBoard f={f} />

        <MinecraftLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function minecraftFacts({ data }: { data: Extract<GamingData, { tab: 'minecraft' }> }) {
  const { minecraft: mc, builds, events, roster } = data
  const behind = builds.behind.length
  // Being behind on BUILDS is routine — Paper cuts several a day. Being behind
  // on the game is the one that stops people joining, so it is the verdict.
  const stale = mc.latestVersion !== null && mc.version !== null && mc.latestVersion !== mc.version
  return { data, mc, builds, events, roster, behind, stale }
}

type MinecraftFacts = NonNullable<ReturnType<typeof minecraftFacts>>

function Panel({ f }: { f: MinecraftFacts }) {
  const { data } = f
  return (
    data.update.notes.length > 0 && (
      <Board
        title={`What ${data.update.notes[0]?.version ?? ''} brings`}
        icon="panels"
        span={6}
        aside={<span className={NOTE}>mojang</span>}
      >
        <ReleaseNotes releases={data.update.notes} />
        <p className={FOOT}>
          Mojang's own release notes for every release after the one running, from the launcher's
          feed — the first bullets of each section; the version links to the full page on the wiki.
        </p>
      </Board>
    )
  )
}

function ComingsAndGoingsBoard({ f }: { f: MinecraftFacts }) {
  const { events } = f
  return (
    <Board
      title="Comings and goings"
      icon="panels"
      span={6}
      aside={<span className={NOTE}>last 7 days</span>}
    >
      {events.length === 0 ? (
        <p className={EMPTY}>nobody has joined this week</p>
      ) : (
        <ul className={NEWS}>
          {events.map((e) => (
            <li key={`${String(e.at)}-${e.who}`} className={NEWS_ROW}>
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
      {/* The log is the record — see joinsAndLeaves in data/minecraft.ts. */}
      <p className={FOOT}>
        Parsed from the server’s log in Loki, newest first. The panel below is the whole log; this
        is the part about people.
      </p>
    </Board>
  )
}

function HowItIsRunBoard({ f }: { f: MinecraftFacts }) {
  const { mc } = f
  return (
    <Board title="How it is run" icon="⚒" span={12}>
      <Facts
        rows={[
          { k: 'Address', v: <span className={MONO}>{mc.connect}</span> },
          {
            k: 'Who gets in',
            v: 'Mojang session auth, plus an enforced whitelist kept in site.json and edited above',
          },
          {
            k: 'Ingress',
            v: 'TCP 25565 forwarded by the router. No tunnel: Minecraft offers no TLS, so traefik has no SNI to route on',
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
  )
}

function ContainersBoard({ f }: { f: MinecraftFacts }) {
  const { data } = f
  return (
    <Board
      title="Containers"
      icon="panels"
      span={12}
      aside={<span className={NOTE}>the server image and its exporter</span>}
    >
      {data.images.length === 0 ? (
        <p className={EMPTY}>neither container carries a digest pin this box publishes</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[0.3rem] p-0">
          {data.images.map((r) => (
            <ImageRow key={r.container} r={r} status={data.imageStatus} />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        The images, not the game: the server image is itzg's, which downloads the Paper jar above on
        every start, and minecraft-monitor turns the status ping into the numbers on this page. Open
        a row for its release notes and the update — the same row System › Updates draws.
      </p>
    </Board>
  )
}

function MinecraftLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'minecraft' }}
      title="Minecraft logs"
      neighbours={[
        {
          source: { container: 'minecraft-monitor' },
          label: 'minecraft-monitor',
          role: 'the exporter',
          note: 'The status-ping exporter behind the players and ping numbers. Errors here mean the page reads "not scraped", not that the server is down.',
        },
        {
          source: { unit: 'minecraft-roster' },
          label: 'minecraft-roster',
          role: 'the whitelist sync',
          note: 'Hands the roster to the running server after every start and every Apply that moves it.',
        },
        {
          source: { unit: 'daedalus-version-update@.service' },
          label: 'daedalus-version-update',
          role: 'the version updater',
          note: 'What an Update above did, phase by phase — the build, the snapshot, the verify, any rollback.',
        },
        {
          source: { unit: 'minecraft-backup' },
          label: 'minecraft-backup',
          role: 'the nightly archive',
          note: 'The quiesced world archive written to the data pool every night.',
        },
      ]}
    />
  )
}
