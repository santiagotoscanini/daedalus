import { BarList, Board, BoardGrid, BigStat, Chip, Facts, Pulse, Ring, StatBand } from '../viz'
import { DASH, bytes, num } from '../../lib/dashboard/format'
import type { HomeData } from '../../server/category'

// The Home page: the household's own data.
//
// Home Assistant leads because it is the only thing here that changes minute
// to minute; everything below it is a library that grows slowly. The pantry
// panel is placed high despite being small because it is the one panel with a
// deadline attached — food expires whether or not anyone looked.

export function HomeView({ data }: { data: HomeData }) {
  const { hass, photos, files, pantry, sso } = data
  const homeCount = hass.people.filter((p) => p.home).length
  const pantryAlarm = (pantry.overdue ?? 0) + (pantry.expired ?? 0)

  return (
    <>
      <StatBand>
        <BigStat
          label="People home"
          value={hass.reachable ? num(homeCount) : DASH}
          tone={homeCount > 0 ? 'ok' : 'muted'}
          sub={hass.people.length === 0 ? 'no person entities' : `of ${String(hass.people.length)}`}
        />
        <BigStat
          label="Lights on"
          value={hass.reachable ? num(hass.lightsOn) : DASH}
          tone={hass.lightsOn > 0 ? 'accent' : 'muted'}
          sub={`of ${num(hass.lightsTotal)}`}
        />
        <BigStat
          label="Photos"
          value={num(photos.photos)}
          tone="info"
          sub={`${num(photos.videos)} videos`}
        />
        <BigStat
          label="Expiring soon"
          value={num((pantry.due ?? 0) + pantryAlarm)}
          tone={pantryAlarm > 0 ? 'bad' : 'ok'}
          sub={pantryAlarm > 0 ? `${String(pantryAlarm)} already overdue` : 'nothing overdue'}
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Home Assistant"
          icon="⌂"
          span={8}
          aside={
            hass.reachable ?
              <span className="board-note">{num(hass.entities)} entities</span>
            : <span className="board-note text-bad">not answering</span>
          }
        >
          {hass.people.length > 0 && (
            <ul className="people">
              {hass.people.map((p) => (
                <li key={p.name} className={p.home ? 'people-row people-home' : 'people-row'}>
                  <Pulse on={p.home} tone="ok" />
                  <span>{p.name}</span>
                  <em>{p.home ? 'home' : 'away'}</em>
                </li>
              ))}
            </ul>
          )}

          {hass.temperatures.length > 0 && (
            <>
              <h4 className="board-sub">Temperature</h4>
              <div className="temps">
                {hass.temperatures.map((t) => (
                  <span key={t.label} className="temps-item">
                    <strong>{t.value.toFixed(1)}°</strong>
                    <em title={t.label}>{t.label}</em>
                  </span>
                ))}
              </div>
            </>
          )}

          <h4 className="board-sub">Entities by domain</h4>
          <BarList items={hass.domains} tone="info" empty="nothing to count" />

          {hass.unavailable > 0 && (
            // Counted rather than listed: the 25 Tuya bulbs that lost their
            // WiFi pairing would be the whole panel, and the number is what
            // tells you whether that set has grown.
            <p className="board-foot text-warn">
              {num(hass.unavailable)} entities are unavailable or unknown.
            </p>
          )}
        </Board>

        <Board title="Pantry" icon="◱" span={4}>
          <Facts
            rows={[
              { k: 'Due within 3 days', v: num(pantry.due) },
              {
                k: 'Overdue',
                v: (pantry.overdue ?? 0) > 0 ? <span className="text-warn">{num(pantry.overdue)}</span> : num(pantry.overdue),
              },
              {
                k: 'Expired',
                v: (pantry.expired ?? 0) > 0 ? <span className="text-bad">{num(pantry.expired)}</span> : num(pantry.expired),
              },
              { k: 'Missing from stock', v: num(pantry.missing) },
            ]}
          />
        </Board>

        <Board title="Photos" icon="◨" span={6}>
          <div className="library-split">
            <Ring
              // Library size against nothing: the API key lacks the
              // `server.storage` permission, so there is no honest
              // denominator. The ring is the split between stills and video,
              // which IS a whole this data describes.
              pct={
                photos.photos === null || photos.videos === null ?
                  null
                : (photos.photos / Math.max(1, photos.photos + photos.videos)) * 100
              }
              value={num(photos.photos)}
              label="stills"
              tone="info"
            />
            <Facts
              rows={[
                { k: 'Videos', v: num(photos.videos) },
                { k: 'Library size', v: bytes(photos.usageBytes) },
                { k: 'Users', v: num(photos.users) },
              ]}
            />
          </div>
        </Board>

        <Board title="Files" icon="▤" span={6}>
          <Facts
            rows={[
              { k: 'Free space', v: bytes(files.freeBytes) },
              { k: 'Files', v: num(files.numFiles) },
              { k: 'Shares', v: num(files.shares) },
              { k: 'Active users (5 min)', v: num(files.activeUsers) },
              { k: 'Nextcloud', v: files.version ?? DASH },
            ]}
          />
        </Board>

        <Board title="Identity" icon="⚿" span={6}>
          <div className="metric-pair">
            <BigStat label="SSO clients" value={num(sso.clients)} />
            <BigStat label="Accounts" value={num(sso.users)} tone="info" />
          </div>
          <p className="board-foot">
            Every admin UI on the box is gated by Pocket ID. A client here is one application
            trusting it.
          </p>
        </Board>

        <Board title="Projects" icon="◰" span={6}>
          <Facts
            rows={[
              { k: 'Plane', v: data.finance.plane ?? DASH },
              {
                k: 'Latest release',
                v:
                  data.finance.planeLatest === null ? DASH
                  : data.finance.planeLatest === data.finance.plane ?
                    <Chip tone="ok">up to date</Chip>
                  : <Chip tone="warn">{data.finance.planeLatest} available</Chip>,
              },
            ]}
          />
        </Board>
      </BoardGrid>
    </>
  )
}
