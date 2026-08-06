import { Board, BoardGrid, Chip, Facts } from '../viz'
import { GrafanaLogs } from '../logs'
import { ReleaseNotes, UpgradeChain } from '../release-notes'
import { ServiceHead } from '../service-head'
import type { GamingData } from '../../server/category'

// The Gaming page. One server today; the shape is meant to take a second.
//
// It leads with the version rather than with uptime because that is the fact
// that actually breaks things here: a client on a different build cannot join
// at all, so "am I current" is the question. Whether it is up is answered by
// the dot on the sub-tab, one level up — see CategorySpec.tabs — which is
// also where a second game server's answer will be, so the two are read
// together rather than one page at a time.
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
  if (data.tab === 'minecraft') return <MinecraftView />
  return <FactorioView data={data} />
}

/**
 * Declared but not deployed.
 *
 * The tab exists so the shape is settled before the server is — and it says
 * so plainly rather than rendering empty gauges, which would read as a broken
 * server instead of an absent one. It makes no requests: there is nothing
 * there to ask.
 */
function MinecraftView() {
  return (
    <>
      <ServiceHead
        logo="/icon-minecraft.svg"
        name="Minecraft"
        version={null}
        lede="No server yet — nothing to read, so nothing is claimed."
        actions={<Chip tone="muted">planned</Chip>}
      />

      <BoardGrid>
        <Board title="What it would take" icon="⚒" span={12}>
          <Facts
            rows={[
              { k: 'Stack', v: 'stacks/minecraft — not written yet' },
              { k: 'Port', v: 'TCP 25565 — would need a router forward, unlike Factorio’s UDP' },
              { k: 'Admin', v: 'LAN-only behind traefik, like every other UI here' },
              { k: 'World', v: 'under /s2, so the ZFS snapshots would cover it' },
            ]}
          />
          <p className="board-foot">
            Factorio next door is the template: a build pinned in the flake, the vendor’s idea of
            current, and the release notes between the two.
          </p>
        </Board>
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
          current ?
            { label: 'current', tone: 'ok' }
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
          icon="≡"
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
            {current ?
              'What the running build shipped, '
            : 'Everything between the running build and stable, '}
            parsed from the wiki’s page source. Open one for the fixes; the link inside goes to the
            full section.
          </p>
        </Board>

        <Board
          title="From the devs"
          icon="◫"
          span={6}
          aside={<span className="board-note">factorio.com/blog</span>}
        >
          {news.length === 0 ?
            <p className="viz-empty">could not read the feed</p>
          : <ul className="news">
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
          }
          {/* Was "release posts are the changelog — there is no structured
              one", which was true when this panel stood alone and is now flatly
              contradicted by the structured changelog sitting next to it. */}
          <p className="board-foot">
            The studio’s own feed, which points forward: Friday Facts are what is being built
            rather than what has landed. What landed is the panel beside this one.
          </p>
        </Board>

        {/* Grafana itself rather than a log viewer of our own — see the note
            in components/logs.tsx and stacks/monitoring, which already allows
            this exact frame-ancestor. */}
        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'factorio' }} title="Factorio logs" />
        </Board>
      </BoardGrid>
    </>
  )
}
