import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Facts,
  Measures,
  Progress,
  Pulse,
  Ring,
} from '../viz'
import { LogBoard } from '../logs'
import { Changelog } from '../release-notes'
import { IdpView } from './idp'
import { ServiceHead, verdictOf, type CompareRow } from '../service-head'
import { DASH, bytes, num, pct } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { RunningVersion } from '../../lib/dashboard/images'
import type { HomeData } from '../../server/category'

// The Home pages — a tab per household subject.
//
// Read the same way as every Media and AI tab: artwork, the name, the version
// running, the verdict on whether that version is current, one sentence saying
// what this thing is FOR, and the link you came to click. Eight services whose
// UIs look nothing alike become eight pages read identically.
//
// The rule on the tab row separates what the house shares from what one person
// uses. See the note in the loader for why that is the line.

export function HomeView({ data }: { data: HomeData }) {
  switch (data.tab) {
    case 'house':
      return <HouseView d={data} />
    case 'photos':
      return <PhotosView d={data} />
    case 'files':
      return <FilesView d={data} />
    case 'pantry':
      return <PantryView d={data} />
    case 'signin':
      return <IdpView d={data} />
    case 'projects':
      return <ProjectsView d={data} />
    case 'finance':
      return <FinanceView d={data} />
    case 'tools':
      return <ToolsView d={data} />
  }
}

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * The working behind a version verdict, shown on hover.
 *
 * `note` says where the running number came from, which is what decides how
 * much the verdict is worth: a version the service reported about itself is a
 * measurement, one read off the image is a claim the publisher made.
 */
function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [
    {
      k: 'Latest',
      v: gap.latest,
      note:
        gap.latest === null ? 'GitHub did not answer'
        : gap.behind.length === 0 ? 'this is what is running'
        : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
    },
    { k: 'Running', v: gap.installed, note },
  ]
}

const SOURCE_NOTE: Record<RunningVersion['source'], string> = {
  pin: 'from the tag the flake pins',
  label: 'from the image’s own label',
  unknown: 'unknown — the pin names a channel',
}

/**
 * The button every service head carries.
 *
 * `host` is the published label, NOT the webApp key — two of the eight differ
 * (`home-assistant` is served at `homeassistant`, `pocket-id` at `id`) and
 * deriving one from the other is how a dashboard grows links that 404.
 */
function Open({ name, host }: { name: string; host: string }) {
  return (
    <a
      className="btn btn-primary"
      href={`https://${host}.toscanini.me`}
      target="_blank"
      rel="noreferrer"
    >
      Open {name} ↗
    </a>
  )
}

/* ── House: Home Assistant ────────────────────────────────────────────── */

type House = Extract<HomeData, { tab: 'house' }>

function HouseView({ d }: { d: House }) {
  const homeCount = d.people.filter((p) => p.home).length

  return (
    <>
      <ServiceHead
        logo="/icon-home-assistant.png"
        name="Home Assistant"
        version={d.version}
        versionNote="reported by the running process"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/config — what it says about itself')}
        lede={
          <>
            The automation hub, and the only container on this box in the host network namespace —
            mDNS and SSDP discovery do not cross a bridge, so every IoT integration would otherwise
            need hand-typed addresses.
          </>
        }
        actions={<Open name="Home Assistant" host="homeassistant" />}
      />

      <BoardGrid>
        <Board
          title="The house"
          icon="⌂"
          span={8}
          aside={
            d.reachable ?
              <span className="board-note">
                {num(d.entities)} entities · {num(d.integrations)} integrations
              </span>
            : <span className="board-note text-bad">not answering</span>
          }
        >
          {d.people.length > 0 && (
            <ul className="people">
              {d.people.map((p) => (
                <li key={p.name} className={p.home ? 'people-row people-home' : 'people-row'}>
                  <Pulse on={p.home} tone="ok" />
                  <span>{p.name}</span>
                  <em>{p.home ? 'home' : 'away'}</em>
                </li>
              ))}
            </ul>
          )}

          <Measures
            items={[
              { k: 'people home', v: d.reachable ? num(homeCount) : DASH },
              { k: 'lights on', v: `${num(d.lightsOn)} / ${num(d.lightsTotal)}` },
              { k: 'switches on', v: num(d.switchesOn) },
              { k: 'automations on', v: `${num(d.automations.on)} / ${num(d.automations.total)}` },
            ]}
          />

          {d.temperatures.length > 0 && (
            <>
              <h4 className="board-sub">Temperature</h4>
              <div className="temps">
                {d.temperatures.map((t) => (
                  <span key={t.label} className="temps-item">
                    <strong>{t.value.toFixed(1)}°</strong>
                    <em title={t.label}>{t.label}</em>
                  </span>
                ))}
              </div>
            </>
          )}

          <h4 className="board-sub">Entities by domain</h4>
          <BarList items={d.domains} tone="info" empty="nothing to count" />
        </Board>

        <Board title="Not answering" icon="⚠" span={4}>
          {/* Split by domain rather than counted. The count is never zero and
              never will be — 25 Tuya bulbs have been unavailable since they
              lost their WiFi pairing — so the only reading worth having is
              whether the set has grown somewhere NEW. */}
          <BarList
            items={d.unavailableBy}
            tone="warn"
            empty="every entity is reporting"
          />
          <p className="board-foot">
            {num(d.unavailable)} of {num(d.entities)} entities are <b>unavailable</b> or{' '}
            <b>unknown</b>. Most of that is the Tuya lights, which have been off the network since
            they lost their pairing and need re-pairing from the app — a number that will not fall
            on its own. A domain appearing here that did not before is the thing to notice.
          </p>
        </Board>

        <Board title="Where" icon="◉" span={4}>
          <Facts
            rows={[
              { k: 'Location', v: d.place.name ?? DASH },
              { k: 'Country', v: d.place.country ?? DASH },
              { k: 'Time zone', v: d.place.timeZone ?? DASH },
              {
                k: 'State',
                v:
                  d.place.state === null ? DASH
                  : d.place.state === 'RUNNING' ? <Chip tone="ok">running</Chip>
                  : <Chip tone="warn">{d.place.state.toLowerCase()}</Chip>,
              },
            ]}
          />
          <p className="board-foot">
            Read back from the instance rather than restated here — a time zone that has drifted
            from the host&rsquo;s is what makes an automation fire an hour late.
          </p>
        </Board>

        <Changelog gap={d.gap} span={8} />

        <LogBoard
          source={{ container: 'home-assistant' }}
          title="Home Assistant logs"
          neighbours={[
            {
              source: { unit: 'ha-dbus-relay.service' },
              label: 'D-Bus relay',
              role: 'how it reaches the Bluetooth adapter',
              note: 'The host system bus rejects a connection from container root, so this relay passes the socket through with the uid rewritten — and it has to forward SCM_RIGHTS as well, which is why a plain xdg-dbus-proxy does not work. Bluetooth integrations going quiet after a reboot is this unit not having come up. Defined in platform/bluetooth.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

/* ── Photos: Immich ───────────────────────────────────────────────────── */

type Photos = Extract<HomeData, { tab: 'photos' }>

function PhotosView({ d }: { d: Photos }) {
  const total = (d.photos ?? 0) + (d.videos ?? 0)

  return (
    <>
      <ServiceHead
        logo="/icon-immich.svg"
        name="Immich"
        version={d.version}
        versionNote="reported by the server"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/server/version')}
        lede={
          <>
            The photo and video library — every phone in the house backs up here, and it is where
            the pictures moved to when Nextcloud stopped being the place for them.
          </>
        }
        actions={<Open name="Immich" host="immich" />}
      />

      <BoardGrid>
        <Board
          title="Library"
          icon="◨"
          span={8}
          aside={<span className="board-note">{num(total)} items</span>}
        >
          <div className="library-split">
            {/* The ring is the split between stills and video, which IS a
                whole this data describes — unlike library size, which has no
                honest denominator here. */}
            <Ring
              pct={total === 0 ? null : ((d.photos ?? 0) / total) * 100}
              value={num(d.photos)}
              label="stills"
              tone="info"
            />
            <Facts
              rows={[
                { k: 'Videos', v: num(d.videos) },
                { k: 'Stills on disk', v: bytes(d.usagePhotos) },
                { k: 'Video on disk', v: bytes(d.usageVideos) },
                { k: 'Library total', v: bytes(d.usageBytes) },
              ]}
            />
          </div>
          <p className="board-foot">
            Video is {pct(d.usageBytes === null || d.usageBytes === 0 ? null : ((d.usageVideos ?? 0) / d.usageBytes) * 100)}{' '}
            of what is stored and {pct(total === 0 ? null : ((d.videos ?? 0) / total) * 100)} of what
            is in it — the ratio that decides how fast this dataset grows.
          </p>
        </Board>

        <Board title="Disk" icon="▦" span={4}>
          <Progress
            pct={
              d.disk.usedBytes === null || d.disk.freeBytes === null ?
                null
              : (d.disk.usedBytes / (d.disk.usedBytes + d.disk.freeBytes)) * 100
            }
            tone="info"
          />
          <Measures
            items={[
              { k: 'used', v: bytes(d.disk.usedBytes) },
              { k: 'free', v: bytes(d.disk.freeBytes) },
            ]}
          />
          <p className="board-foot">
            The <span className="mono">/s2/immich</span> dataset, read from node_exporter. Immich&rsquo;s
            own storage endpoint needs a permission this API key does not carry, and the dataset
            underneath is the same disk — a real denominator rather than an invented one. Hourly,
            daily and weekly snapshots; on the mirror, so a single drive failure costs nothing.
          </p>
        </Board>

        <Board title="Who is backing up" icon="◑" span={4}>
          <ul className="itemlist">
            {d.users.map((u) => (
              <li key={u.name}>
                <span className="item-main">{u.name}</span>
                <span className="item-side">
                  {num(u.photos)} + {num(u.videos)} video
                </span>
                <span className="item-n">{bytes(u.usageBytes)}</span>
              </li>
            ))}
          </ul>
          {d.users.length === 0 && <p className="viz-empty">could not read the user list</p>}
          <p className="board-foot">
            Quotas are unset on every account, so the only ceiling is the dataset above.
          </p>
        </Board>

        <Changelog gap={d.gap} span={8} />

        <LogBoard
          source={{ stack: 'immich' }}
          title="Immich logs"
          foot={
            <p className="board-foot">
              The whole stack rather than one container: the server, the machine-learning worker
              that does face and object recognition, and its Redis. A backup that appears to hang is
              usually the ML worker, which logs there and nowhere else.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/* ── Files: Nextcloud ─────────────────────────────────────────────────── */

type Files = Extract<HomeData, { tab: 'files' }>

function FilesView({ d }: { d: Files }) {
  const openLinks = d.shares.linkNoPassword ?? 0

  return (
    <>
      <ServiceHead
        logo="/icon-nextcloud.svg"
        name="Nextcloud"
        version={d.version}
        versionNote="reported by the server"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from the serverinfo app — four segments to GitHub’s three')}
        lede={
          <>
            File sync, calendar and contacts. Its database lives on the shared Postgres cluster and
            its image is built locally with ffmpeg baked in, which the preview generator and the
            recognize app both want.
          </>
        }
        actions={<Open name="Nextcloud" host="nextcloud" />}
      />

      <BoardGrid>
        <Board
          title="Sharing"
          icon="⇗"
          span={8}
          aside={<span className="board-note">{num(d.shares.total)} shares</span>}
        >
          <Measures
            items={[
              { k: 'public links', v: num(d.shares.link) },
              { k: 'without a password', v: num(d.shares.linkNoPassword) },
              { k: 'to a user', v: num(d.shares.user) },
              { k: 'to a group', v: num(d.shares.group) },
            ]}
          />
          {/* The one fact on this page that is worth acting on, and the one a
              tile of four stats had no room for. */}
          <p className={openLinks > 0 ? 'board-foot text-warn' : 'board-foot'}>
            {openLinks > 0 ?
              <>
                <b>{num(openLinks)}</b> of {num(d.shares.link)} public links carry no password, so
                each is a URL that opens the file for anyone holding it. That is how a link share is
                normally used — sending one to somebody who has no account here is the entire point
                — but it means the count above is the number of files whose security is the secrecy
                of a URL.
              </>
            : <>Every public link is password-protected.</>}
          </p>
        </Board>

        <Board title="Contents" icon="▤" span={4}>
          <Facts
            rows={[
              { k: 'Files', v: num(d.numFiles) },
              { k: 'Storages', v: num(d.storages) },
              { k: 'Accounts', v: num(d.users.total) },
              { k: 'Disabled', v: num(d.users.disabled) },
              { k: 'Free space', v: bytes(d.freeBytes) },
            ]}
          />
        </Board>

        <Board title="Who is using it" icon="◑" span={4}>
          <Measures
            items={[
              { k: 'last 5 min', v: num(d.active.m5) },
              { k: 'last hour', v: num(d.active.h1) },
              { k: 'last day', v: num(d.active.d1) },
              { k: 'last week', v: num(d.active.d7) },
            ]}
          />
          <p className="board-foot">
            Sign-in is Pocket ID only — the login form is hidden, so there is no password on this
            instance to guess or reuse.
          </p>
        </Board>

        <Board title="Underneath" icon="⚙" span={4}>
          <Facts
            rows={[
              { k: 'Database', v: d.db.type === null ? DASH : `${d.db.type} · ${d.db.version ?? ''}` },
              { k: 'Database size', v: bytes(d.db.sizeBytes) },
              { k: 'PHP', v: d.php.version ?? DASH },
              { k: 'Opcache hit rate', v: pct(d.php.opcacheHitRate, 2) },
              { k: 'Distributed cache', v: (d.cache ?? DASH).replace(/^\\?OC\\Memcache\\/, '') },
            ]}
          />
          <p className="board-foot">
            The database is a tenant of the shared cluster, not a container of its own — it appears
            on System &rsaquo; Database with every other app&rsquo;s.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ stack: 'nextcloud' }}
          title="Nextcloud logs"
          neighbours={[
            {
              source: { unit: 'nextcloud-cron.service' },
              label: 'Cron',
              role: 'the background jobs, every five minutes',
              note: 'Nextcloud does its housekeeping — file scans, previews, notifications, app updates — from cron.php rather than from web requests, so a stalled timer looks like an instance that has stopped noticing new files while serving them perfectly. Runs `occ` inside the app container as www-data.',
            },
            {
              source: { unit: 'nextcloud-image-build.service' },
              label: 'Image build',
              role: 'where the running image comes from',
              note: 'The official image ships no ffmpeg, which the preview generator and the recognize app both need, so this builds a local wrapper before the app starts. The tag embeds the build context’s store hash — an unchanged context rebuilds from cache in seconds, a changed one produces a new tag and restarts the container.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

/* ── Pantry: Grocy ────────────────────────────────────────────────────── */

type Pantry = Extract<HomeData, { tab: 'pantry' }>

function PantryView({ d }: { d: Pantry }) {
  const alarm = (d.overdue ?? 0) + (d.expired ?? 0)

  return (
    <>
      <ServiceHead
        logo="/icon-grocy.svg"
        name="Grocy"
        version={d.version}
        versionNote={d.releaseDate === null ? 'reported by the app' : `released ${d.releaseDate}`}
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/system/info')}
        lede={
          <>
            Household stock, chores and tasks. A PHP-FPM image, so it is one of the two containers
            here that refuse to run as container root and keep the linuxserver default uid instead.
          </>
        }
        actions={<Open name="Grocy" host="grocy" />}
      />

      <BoardGrid>
        <Board
          title="Stock"
          icon="◱"
          span={8}
          aside={<span className="board-note">{num(d.inStock)} products on hand</span>}
        >
          <Measures
            items={[
              { k: 'due in 3 days', v: num(d.due) },
              { k: 'overdue', v: num(d.overdue) },
              { k: 'expired', v: num(d.expired) },
              { k: 'missing from stock', v: num(d.missing) },
            ]}
          />
          <p className={alarm > 0 ? 'board-foot text-warn' : 'board-foot'}>
            {alarm > 0 ?
              <>
                <b>{num(alarm)}</b> products are past their date. Grocy distinguishes the two:{' '}
                <b>overdue</b> is past the best-before and still fine, <b>expired</b> is past the
                use-by. Nothing here alerts — this is the only place it is said.
              </>
            : <>
                Nothing is past its date. &ldquo;Missing&rdquo; is a product below its minimum stock
                level rather than one that has run out, which is the list a shopping trip is built
                from.
              </>
            }
          </p>
        </Board>

        <Board title="Chores & tasks" icon="✓" span={4}>
          <Facts
            rows={[
              { k: 'Chores tracked', v: num(d.chores.total) },
              {
                k: 'Chores overdue',
                v:
                  (d.chores.overdue ?? 0) > 0 ?
                    <span className="text-warn">{num(d.chores.overdue)}</span>
                  : num(d.chores.overdue),
              },
              { k: 'Open tasks', v: num(d.tasks.total) },
              {
                k: 'Tasks overdue',
                v:
                  (d.tasks.overdue ?? 0) > 0 ?
                    <span className="text-warn">{num(d.tasks.overdue)}</span>
                  : num(d.tasks.overdue),
              },
            ]}
          />
          <p className="board-foot">
            Both lists are empty on this instance — the stock half is what it is used for.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'grocy' }} title="Grocy logs" />
      </BoardGrid>
    </>
  )
}

/* ── Projects: Plane ──────────────────────────────────────────────────── */

type Projects = Extract<HomeData, { tab: 'projects' }>

function ProjectsView({ d }: { d: Projects }) {
  return (
    <>
      <ServiceHead
        logo="/icon-plane.png"
        name="Plane"
        version={d.version}
        versionNote="reported by the instance"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/instances/ — the one endpoint that needs no key')}
        lede={
          <>
            Projects, cycles and work items. The one published application on this box that is{' '}
            <em>not</em> behind the Pocket ID gate — Community edition has no OIDC, so it keeps its
            own sign-in.
          </>
        }
        actions={<Open name="Plane" host="plane" />}
      />

      <BoardGrid>
        <Board title="Instance" icon="◰" span={6}>
          <Facts
            rows={[
              { k: 'Name', v: d.instanceName ?? DASH },
              { k: 'Edition', v: d.edition === null ? DASH : d.edition.replace('PLANE_', '') },
              {
                k: 'Plane says latest is',
                v:
                  d.latest === null ? DASH
                  : d.latest.replace(/^v/, '') === d.version ? <Chip tone="ok">what is running</Chip>
                  : <Chip tone="warn">{d.latest}</Chip>,
              },
              { k: 'Outbound mail', v: d.smtp === true ? <Chip tone="ok">configured</Chip> : <Chip tone="muted">off</Chip> },
            ]}
          />
          <p className="board-foot">
            Two independent answers to &ldquo;is this current&rdquo;: Plane phones its own servers,
            and the verdict beside the version compares against GitHub the way every other tab here
            does. They should agree; when they do not, the second one is the one this box can check.
          </p>
        </Board>

        <Board title="How people get in" icon="⚿" span={6}>
          <Facts
            rows={[
              {
                k: 'Sign-ups',
                v: d.signIn.signup === true ? <Chip tone="warn">open</Chip> : <Chip tone="ok">closed</Chip>,
              },
              { k: 'Magic link', v: d.signIn.magicLink === true ? 'on' : 'off' },
              { k: 'Email + password', v: d.signIn.emailPassword === true ? 'on' : 'off' },
              { k: 'Single sign-on', v: <Chip tone="muted">not in Community</Chip> },
            ]}
          />
          <p className="board-foot">
            Read back from the instance rather than restated. This is the deliberate exception to
            the rule that every UI here signs in through Pocket ID: the edition simply has no OIDC
            client to point at it, so the mitigation is that sign-ups are closed and the account
            list is one person.
          </p>
        </Board>

        <Board
          title="Work"
          icon="◫"
          span={12}
          aside={
            d.workspace === null ?
              undefined
            : <span className="board-note">workspace {d.workspace.slug}</span>
          }
        >
          {d.workspace === null ?
            <>
              <p className="viz-empty">No workspace API token — this section needs one.</p>
              <p className="board-foot">
                Plane&rsquo;s instance endpoint above needs no credential, but everything{' '}
                <em>inside</em> a workspace does, and the token is generated from Plane&rsquo;s own
                settings rather than declared in nix. A missing key rather than a broken panel.
              </p>
            </>
          : d.workspace.projects.length === 0 ?
            <p className="viz-empty">No projects in this workspace.</p>
          : <>
              {d.workspace.projects.map((p) => (
                <PlaneProjectRows key={p.id} p={p} />
              ))}
              <p className="board-foot">
                Counted by state <b>group</b> rather than by state: the names are per-project and
                anybody can rename &ldquo;Todo&rdquo;, but the five groups are Plane&rsquo;s own
                fixed vocabulary, so this tally survives that. A cycle is time-boxed — the bar is
                how much of it is done, and one that has ended with work still in it is the thing
                this panel is for.
              </p>
            </>
          }
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ stack: 'plane' }}
          title="Plane logs"
          neighbours={[
            {
              source: { unit: 'plane-migrate.service' },
              label: 'Migrations',
              role: 'what runs before the API will start',
              note: 'Plane ships its schema migrations as a separate step, and the API comes up broken rather than not at all if they have not run. A unit rather than a container that exits quietly, so a failure sends mail — see fleet.monitoredJobs in stacks/plane.',
            },
          ]}
          foot={
            <p className="board-foot">
              The whole stack: the web front end, the API, the worker, the beat scheduler, its Redis
              and its object store. &ldquo;Plane is slow&rdquo; is almost always the worker.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

type PlaneProject = NonNullable<Projects['workspace']>['projects'][number]

/** One project: its board in five numbers, then its cycles. */
function PlaneProjectRows({ p }: { p: PlaneProject }) {
  return (
    <>
      <h4 className="board-sub">
        {p.name}
        {p.identifier !== null && <span className="muted"> · {p.identifier}</span>}
      </h4>

      <Measures
        items={[
          ...p.states.map((s) => ({ k: s.label, v: num(s.value) })),
          { k: 'members', v: num(p.members) },
        ]}
      />

      {p.cycles.length === 0 ?
        <p className="viz-empty">no cycles</p>
      : <ul className="itemlist">
          {p.cycles.map((c) => (
            <li key={c.name}>
              <span className="item-main">
                {c.name}
                {c.current && (
                  <>
                    {' '}
                    <Chip tone="ok">running</Chip>
                  </>
                )}
              </span>
              <span className="item-side">
                {c.startDate ?? DASH} → {c.endDate ?? DASH}
              </span>
              <span className="item-side">
                {/* Completed against total, because a cycle's whole point is
                    that it ends whether or not the work did. */}
                {num(c.completed)} / {num(c.total)} done
              </span>
              <span className="item-n">{pct(c.total === 0 ? null : (c.completed / c.total) * 100)}</span>
            </li>
          ))}
        </ul>
      }

      {p.scanned !== null && (
        // Said out loud rather than silently capped: a breakdown of the first
        // hundred of four hundred reads exactly like a breakdown of all of
        // them, and the difference is the whole point of the numbers.
        <p className="board-foot">
          {num(p.items)} work items, of which the breakdown above counts the first{' '}
          {num(p.scanned)} — the total is complete, the split is a sample.
        </p>
      )}
    </>
  )
}

/* ── Finance: Wealthfolio ─────────────────────────────────────────────── */

type Finance = Extract<HomeData, { tab: 'finance' }>

function FinanceView({ d }: { d: Finance }) {
  return (
    <>
      <ServiceHead
        logo="/icon-wealthfolio.png"
        name="Wealthfolio"
        version={d.running.version}
        versionNote={SOURCE_NOTE[d.running.source]}
        verdict={verdictOf(d.gap)}
        compare={compareOf(
          d.gap,
          d.running.source === 'pin' ?
            'the image tag — the app serves no version'
          : 'the image’s own OCI label',
        )}
        lede={
          <>
            Portfolio and personal finance, signed in through Pocket ID. Everything it holds is one
            person&rsquo;s, which is what puts it on this side of the rule.
          </>
        }
        actions={<Open name="Wealthfolio" host="wealthfolio" />}
      />

      <BoardGrid>
        <Board title="What this page can say" icon="◔" span={12}>
          <Facts
            rows={[
              { k: 'Running', v: d.running.version ?? DASH },
              {
                k: 'Built from',
                v: d.running.revision === null ? DASH : <span className="mono">{d.running.revision}</span>,
              },
              {
                k: 'Latest release',
                v:
                  d.gap.latest === null ? DASH
                  : d.gap.behind.length === 0 ? <Chip tone="ok">up to date</Chip>
                  : <Chip tone="warn">{d.gap.latest}</Chip>,
              },
            ]}
          />
          {/* Said out loud rather than left as an empty page. A panel that is
              blank because nothing was asked and one that is blank because
              the answer is zero look identical otherwise. */}
          <p className="board-foot">
            Deliberately thin. Every path under this hostname returns the single-page app, and the
            API behind it authenticates with a browser session rather than a key — so there is no
            holding, no balance and no transaction count this dashboard can read without being a
            logged-in browser. What is left is real: the version, whether it is current, and the log.
            The alternative was the tile it replaces, which carried a name and a link and answered
            nothing at all.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'wealthfolio' }} title="Wealthfolio logs" />
      </BoardGrid>
    </>
  )
}

/* ── Tools: Stirling-PDF ──────────────────────────────────────────────── */

type Tools = Extract<HomeData, { tab: 'tools' }>

function ToolsView({ d }: { d: Tools }) {
  return (
    <>
      <ServiceHead
        logo="/icon-stirling-pdf.svg"
        name="Stirling-PDF"
        version={d.version}
        versionNote="reported by its status endpoint"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/info/status')}
        lede={
          <>
            Split, merge, rotate, OCR, sign. A toolbox rather than a service: nothing is stored, so
            there is nothing here to back up and nothing to lose.
          </>
        }
        actions={<Open name="Stirling-PDF" host="stirling-pdf" />}
      />

      <BoardGrid>
        <Board title="Status" icon="◔" span={12}>
          <Facts
            rows={[
              {
                k: 'Health',
                v:
                  d.status === null ? DASH
                  : d.status === 'UP' ? <Chip tone="ok">up</Chip>
                  : <Chip tone="warn">{d.status.toLowerCase()}</Chip>,
              },
              { k: 'Version', v: d.version ?? DASH },
              {
                k: 'Latest release',
                v:
                  d.gap.latest === null ? DASH
                  : d.gap.behind.length === 0 ? <Chip tone="ok">up to date</Chip>
                  : <Chip tone="warn">{d.gap.latest} available</Chip>,
              },
            ]}
          />
          <p className="board-foot">
            Stateless by design — documents are processed in memory and dropped, which is why this
            tab is a version and a log and stops there. It is also the reason this is the one
            application here that could be deleted and rebuilt from nothing with no loss.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'stirling-pdf' }} title="Stirling-PDF logs" />
      </BoardGrid>
    </>
  )
}
