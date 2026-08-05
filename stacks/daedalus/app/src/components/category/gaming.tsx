import { Board, BoardGrid, Chip, Facts } from '../viz'
import { GrafanaLogs } from '../logs'
import { text } from '../../lib/dashboard/format'
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
      <div className="game-head">
        <img className="game-logo" src="/icon-minecraft.svg" alt="" width={44} height={44} />
        <div className="game-ident">
          <h2>Minecraft</h2>
          <p className="lede">No server yet — nothing to read, so nothing is claimed.</p>
        </div>
        <div className="game-actions">
          <Chip tone="muted">planned</Chip>
        </div>
      </div>

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
      <div className="game-head">
        <img className="game-logo" src="/icon-factorio.png" alt="" width={44} height={44} />
        <div className="game-ident">
          <h2>Factorio</h2>
          {/* The build, attached to the name it is the build OF, with its
              verdict beside it — the two are one sentence, so they sit on one
              line rather than in two cards a screen apart. */}
          <p className="game-version">
            <span className="mono">{text(factorio.installed)}</span>
            <span className="game-version-note">running · re-downloaded on every start</span>
            <VersionCompare
              current={current}
              behind={behind}
              stable={factorio.stable}
              experimental={factorio.experimental}
            />
          </p>
          <p className="lede">
            Headless server behind ofsm. Players connect to{' '}
            <span className="mono">{factorio.connect}</span> over UDP — the one port the router
            forwards inward, and the only thing here that leaves the house.
          </p>
        </div>

        <div className="game-actions">
          <a className="btn btn-primary" href={factorio.adminUrl} target="_blank" rel="noreferrer">
            Open server manager ↗
          </a>
        </div>
      </div>

      <BoardGrid>
        <Board
          title={current ? 'Release notes' : `${String(behind)} to apply`}
          icon="≡"
          span={6}
          fill
          aside={<span className="board-note">wiki.factorio.com</span>}
        >
          {/* The chain lives here rather than in a panel of its own: when
              nothing is pending that panel was an empty box next to a full
              one, which is where the ragged column came from. */}
          {!current && (
            <ol className="relchain">
              {factorio.behind.map((v, i) => (
                <li key={v} className={i === factorio.behind.length - 1 ? 'relchain-last' : ''}>
                  <span className="mono">{v}</span>
                </li>
              ))}
            </ol>
          )}

          {data.changelog.length === 0 ?
            <p className="viz-empty">no release notes for this version</p>
          : <div className="changelog">
              {data.changelog.map((rel, i) => (
                // The newest is open. It is the reason you opened the page in
                // both directions — the next thing to apply when something is
                // pending, and what the running build shipped when nothing is
                // — and a row of collapsed summary is not an answer.
                <details key={rel.version} open={i === 0} className="rel">
                  <summary>
                    <span className="rel-version mono">{rel.version}</span>
                    <span className="rel-date">{rel.date}</span>
                    <span className="rel-count">{rel.sections.map((s) => s.name).join(' · ')}</span>
                  </summary>
                  <div className="rel-body">
                    {rel.sections.map((s) => (
                      <section key={s.name}>
                        <h5>{s.name}</h5>
                        <ul>
                          {s.items.map((it, n) => (
                            <li key={n}>{it}</li>
                          ))}
                        </ul>
                      </section>
                    ))}
                    <p className="rel-more">
                      {rel.truncated && 'Shortened. '}
                      <a href={wikiUrl(rel.version)} target="_blank" rel="noreferrer">
                        Full notes ↗
                      </a>
                    </p>
                  </div>
                </details>
              ))}
            </div>
          }
          <p className="board-foot">
            {current ?
              'What the running build shipped. '
            : 'Everything between the running build and stable. '}
            Parsed from the wiki’s page source; the link opens the full section.
          </p>
        </Board>

        <Board
          title="From the devs"
          icon="◫"
          span={6}
          fill
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
          <p className="board-foot">
            Release posts are the changelog — there is no structured one. Friday Facts are what is
            coming rather than what shipped.
          </p>
        </Board>

        {/* Grafana itself rather than a log viewer of our own — see the note
            in components/logs.tsx and stacks/monitoring, which already allows
            this exact frame-ancestor. */}
        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs container="factorio" title="Factorio logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * The verdict, with what produced it one hover away.
 *
 * "current" is the answer; stable and experimental are the working. Two
 * headline cards spent a quarter of the page restating a comparison that the
 * word already made, so they moved in here — visible on hover and on keyboard
 * focus, and CSS-only, because a popover that needs hydration would be dead
 * for the first moment of a page that streams.
 *
 * `title` is deliberately NOT the mechanism: it truncates, it cannot hold two
 * labelled rows, and it appears after a delay long enough that nobody waits.
 */
function VersionCompare({
  current,
  behind,
  stable,
  experimental,
}: {
  current: boolean
  behind: number
  stable: string | null
  experimental: string | null
}) {
  return (
    <span className="vercmp" tabIndex={0}>
      <Chip tone={current ? 'ok' : 'warn'}>
        {current ? 'current' : `${String(behind)} behind`}
      </Chip>
      <span className="vercmp-card" role="tooltip">
        <span className="vercmp-row">
          <span className="vercmp-k">Stable</span>
          <span className="vercmp-v mono">{text(stable)}</span>
          <span className="vercmp-note">
            {current ? 'this is what is running' : 'what this server should be on'}
          </span>
        </span>
        <span className="vercmp-row">
          <span className="vercmp-k">Experimental</span>
          <span className="vercmp-v mono">{text(experimental)}</span>
          <span className="vercmp-note">not tracked — this server follows stable</span>
        </span>
      </span>
    </span>
  )
}

/**
 * Where a release actually lives on the wiki.
 *
 * There is no page per release. `Version_history/2.1.12` is a red link —
 * every 2.1.x lives as a SECTION of `Version_history/2.1.0`, and the version
 * number is the heading, so the anchor is what lands you on the right one.
 */
function wikiUrl(version: string): string {
  const [maj, min] = version.split('.')
  const series = maj !== undefined && min !== undefined ? `${maj}.${min}.0` : version
  return `https://wiki.factorio.com/Version_history/${series}#${version}`
}
