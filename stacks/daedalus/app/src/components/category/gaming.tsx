import { BigStat, Board, BoardGrid, Chip, Facts, Pulse, StatBand } from '../viz'
import { text } from '../../lib/dashboard/format'
import type { GamingData } from '../../server/category'

// The Gaming page. One server today; the shape is meant to take a second.
//
// It leads with the version rather than with uptime because that is the fact
// that actually breaks things here: a client on a different build cannot join
// at all, so "am I current" is the question, and "is it up" is the easy part
// the status dot already answers.

export function GamingView({ data }: { data: GamingData }) {
  const { factorio, news } = data
  const behind = factorio.behind.length
  const current = behind === 0 && factorio.installed !== null

  return (
    <>
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
          sub="downloaded fresh on every start"
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
          sub="not tracked here"
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Factorio server"
          icon="⚙"
          span={6}
          aside={
            <Chip tone={current ? 'ok' : 'warn'}>{current ? 'current' : 'update available'}</Chip>
          }
        >
          <Facts
            rows={[
              { k: 'Running', v: <span className="mono">{text(factorio.installed)}</span> },
              { k: 'Latest stable', v: <span className="mono">{text(factorio.stable)}</span> },
              { k: 'Experimental', v: <span className="mono">{text(factorio.experimental)}</span> },
              { k: 'Connect', v: <span className="mono">{factorio.connect}</span> },
              { k: 'Protocol', v: `UDP ${String(factorio.port)}` },
            ]}
          />
          {/* The one port the router forwards for this box besides WireGuard,
              and the reason it is acceptable is that it is UDP to a game
              server rather than a TCP service with an admin surface. */}
          <p className="board-foot">
            The game speaks its own UDP protocol and never touches traefik — the router forwards{' '}
            {factorio.port} straight through. The admin UI is the opposite: LAN-only, behind the
            proxy, not exposed at all.
          </p>
        </Board>

        <Board
          title={current ? 'Nothing to apply' : `${String(behind)} release${behind === 1 ? '' : 's'} behind`}
          icon="⇩"
          span={6}
        >
          {current ?
            <p className="viz-empty">
              Running the current stable build. Clients on stable can join.
            </p>
          : <>
              <ol className="relchain">
                {factorio.behind.map((v, i) => (
                  <li key={v} className={i === factorio.behind.length - 1 ? 'relchain-last' : ''}>
                    <span className="mono">{v}</span>
                  </li>
                ))}
              </ol>
              {/* Named as the file and the line, because that is the whole of
                  the change — ofsm re-downloads on the next container start. */}
              <p className="board-foot">
                Updating is one string: <code>factorioVersion</code> in{' '}
                <code>stacks/factorio/factorio.nix</code>, then a rebuild. The container downloads
                the new binary the next time it starts.
              </p>
            </>
          }
        </Board>

        <Board
          title={current ? 'What this build shipped' : 'What you would get'}
          icon="≡"
          span={12}
          aside={<span className="board-note">wiki.factorio.com</span>}
        >
          {data.changelog.length === 0 ?
            <p className="viz-empty">no release notes for this version</p>
          : <div className="changelog">
              {data.changelog.map((rel, i) => (
                // Collapsed by default, except the newest when there is
                // something to apply: that one is the whole reason you opened
                // the page, and a panel of shut drawers answers nothing.
                <details key={rel.version} open={!current && i === 0} className="rel">
                  <summary>
                    <span className="rel-version mono">{rel.version}</span>
                    <span className="rel-date">{rel.date}</span>
                    <span className="rel-count">
                      {rel.sections.map((s) => s.name).join(' · ')}
                    </span>
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
                      <a
                        href={`https://wiki.factorio.com/Version_history/${seriesOf(rel.version)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Full notes ↗
                      </a>
                    </p>
                  </div>
                </details>
              ))}
            </div>
          }
          {/* The wiki is the only per-release changelog Wube publishes in a
              form anything can read — MediaWiki hands over the page source, so
              this parses a stable grammar rather than scraping the layout. */}
          <p className="board-foot">
            Parsed from the wiki&rsquo;s own page source. Long sections are shortened here; the
            link goes to the full page.
          </p>
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
          {/* Wube publishes no machine-readable per-release changelog; the
              release POSTS in this feed are the closest thing, which is why
              they are tagged rather than mixed in with the Friday Facts. */}
          <p className="board-foot">
            Release posts are the changelog — there is no structured one. Friday Facts are what is
            coming rather than what shipped.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

/** `2.0.77` → `2.0.0`, the wiki page that holds the whole minor series. */
function seriesOf(v: string): string {
  const [maj, min] = v.split('.')
  return maj !== undefined && min !== undefined ? `${maj}.${min}.0` : v
}
