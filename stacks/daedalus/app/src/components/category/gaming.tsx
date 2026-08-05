import { BigStat, Board, BoardGrid, Chip, Facts, Pulse, StatBand } from '../viz'
import { GrafanaLogs } from '../logs'
import { text } from '../../lib/dashboard/format'
import type { GamingData } from '../../server/category'

// The Gaming page. One server today; the shape is meant to take a second.
//
// It leads with the version rather than with uptime because that is the fact
// that actually breaks things here: a client on a different build cannot join
// at all, so "am I current" is the question, and "is it up" is the easy part
// the status dot already answers.
//
// ── one fact, one place ───────────────────────────────────────────────────
//
// The headline band owns the version numbers. Nothing below repeats them:
// the panels answer different questions — how do I reach it, what changed,
// what is it saying — and a number that appears twice is a number that can
// disagree with itself.

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
        <div>
          <h2>Minecraft</h2>
          <p className="lede">No server yet — nothing to read, so nothing is claimed.</p>
        </div>
        <Chip tone="muted">planned</Chip>
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
        <div>
          <h2>Factorio</h2>
          <p className="lede">
            Headless server behind ofsm, on the one UDP port the router forwards.
          </p>
        </div>
        <Chip tone={current ? 'ok' : 'warn'}>{current ? 'current' : 'update available'}</Chip>
      </div>

      {/* The band owns the numbers. Every panel below answers a different
          question and repeats none of them. */}
      <StatBand>
        <BigStat
          label="Server"
          value={
            factorio.adminUp === null ? 'unknown'
            : factorio.adminUp ? 'up'
            : 'down'
          }
          tone={factorio.adminUp === false ? 'bad' : 'ok'}
          sub={
            <>
              <Pulse on={factorio.adminUp === true} tone="ok" />
              admin UI answering
            </>
          }
        />
        <BigStat
          label="Running"
          value={text(factorio.installed)}
          tone="accent"
          sub="re-downloaded on every start"
        />
        <BigStat
          label="Stable"
          value={text(factorio.stable)}
          tone={current ? 'ok' : 'warn'}
          sub={current ? 'up to date' : `${String(behind)} release${behind === 1 ? '' : 's'} behind`}
        />
        <BigStat
          label="Experimental"
          value={text(factorio.experimental)}
          tone="muted"
          sub="this server tracks stable"
        />
      </StatBand>

      <BoardGrid>
        <Board title="Reaching it" icon="⚙" span={4}>
          <Facts
            rows={[
              { k: 'Players connect to', v: <span className="mono">{factorio.connect}</span> },
              { k: 'Protocol', v: `UDP ${String(factorio.port)}` },
              {
                // The dependency that is invisible from inside the house and
                // is the first thing to check when someone off-LAN cannot
                // join: nothing on this box can make it true.
                k: 'Requires',
                v: (
                  <>
                    a router forward of <span className="mono">UDP {factorio.port}</span> → this
                    box
                  </>
                ),
              },
              { k: 'Manager', v: 'ofsm — saves, mods, RCON' },
            ]}
          />

          <a className="cta" href={factorio.adminUrl} target="_blank" rel="noreferrer">
            <span className="cta-main">Open the server manager</span>
            <span className="cta-sub">ofsm · LAN only, behind the Pocket ID gate</span>
            <span className="cta-arrow" aria-hidden="true">
              ↗
            </span>
          </a>

          {/* The one exception in the router's forward list, and the reason it
              is acceptable: a game protocol, not an admin surface. */}
          <p className="board-foot">
            Only the game port is forwarded. Everything else about this server — the manager, the
            saves, RCON — is LAN-only and never leaves the house, which is why the address above
            works from outside and the one below does not.
          </p>
        </Board>

        <Board
          title={current ? 'Release notes' : `${String(behind)} to apply`}
          icon="≡"
          span={8}
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
                // Collapsed, except the newest when there is something to
                // apply: that one is the reason you opened the page.
                <details key={rel.version} open={!current && i === 0} className="rel">
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

        {/* Grafana itself rather than a log viewer of our own — see the note
            below and stacks/monitoring, which already allows this exact
            frame-ancestor. */}
        <Board
          title="Logs"
          icon="≡"
          span={12}
        >
          <GrafanaLogs container="factorio" title="Factorio logs" />
        </Board>

        <Board
          title="From the devs"
          icon="◫"
          span={12}
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
      </BoardGrid>
    </>
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
