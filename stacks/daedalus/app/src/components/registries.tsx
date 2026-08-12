// The two shared registries, one tab each.
//
// Built as SERVICE tabs — header, version verdict, readings, changelog, log —
// because that is what they are: zot and verdaccio are containers with release
// cycles, not summaries of the app list. They sit under Apps rather than in a
// category of their own because their only consumer is the apps beside them.

import { DASH, num } from '../lib/dashboard/format'
import type { VersionGap } from '../lib/dashboard/github'
import type { ImagesData, PackagesData } from '../lib/registries'
import { BASE_DOMAIN, REGISTRY_HOST } from '../lib/site'
import { LogBoard, type LogNeighbour } from './logs'
import { Changelog } from './release-notes'
import { type CompareRow, ServiceHead, verdictOf } from './service-head'
import { BarList, Board, BoardGrid, Chip, Facts, Stat, StatStrip } from './viz'

/* ── container registry ───────────────────────────────────────────────── */

/**
 * zot's neighbours.
 *
 * The runners are what PUSH here, so "the image never arrived" is answered in
 * their log rather than zot's — zot only ever saw the pushes it got. The
 * config render is the other end: it writes the htpasswd zot authenticates
 * against, and a failure there leaves a registry that starts and then refuses
 * every credential.
 */
const ZOT_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { stack: 'gha-runner' },
    label: 'Actions runners',
    role: 'what pushes here',
    note: 'Every image in this registry arrives from a self-hosted runner. An image that never appeared is a build that never finished, and that is this log rather than zot’s — zot can only report the pushes it received.',
  },
  {
    source: { unit: 'registry-config-render.service' },
    label: 'registry-config-render',
    role: 'writes the credentials zot checks',
    note: 'A boot oneshot that renders zot’s config with its htpasswd from sops. If it fails, zot still starts and then rejects every push — the runners report an auth error and the registry log shows only the refusal.',
  },
]

export function ImagesView({ d }: { d: ImagesData }) {
  const total = d.repositories.length + d.cachedRepos.length || 0

  return (
    <>
      <ServiceHead
        logo="/icon-zot.png"
        name="zot"
        version={d.version}
        versionNote="from its own zot_info gauge"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the commit label on zot_info')}
        lede={
          <>
            The box’s own container registry. Every app here is built by a runner on this machine
            and pushed to zot, and each app’s deploy timer pulls from it every two minutes — so
            nothing an app runs ever leaves the house.
          </>
        }
        actions={
          <a
            href="https://registry.toscanini.me"
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
          >
            ↗ Open
          </a>
        }
      />

      <StatStrip>
        <Stat
          label="Reachable"
          value={d.reachable ? 'yes' : 'no'}
          tone={d.reachable ? 'ok' : 'bad'}
          sub="anonymous catalogue read"
        />
        <Stat label="App images" value={String(d.repositories.length)} sub="built on this box" />
        <Stat
          label="Upstream cached"
          value={String(d.cachedRepos.length)}
          sub="pulled through zot"
        />
        <Stat
          label="On disk"
          value={d.storageBytes === null ? DASH : fmtBytes(d.storageBytes)}
          sub={`${String(total)} repositories`}
        />
        <Stat
          label="Pushes"
          value={d.pushes === null ? DASH : num(d.pushes)}
          sub="since zot started"
        />
        <Stat
          label="Requests"
          value={d.requestsPerHour === null ? DASH : d.requestsPerHour.toFixed(0)}
          unit="/hour"
          tone={d.errorsPerHour !== null && d.errorsPerHour >= 1 ? 'warn' : undefined}
          sub={
            d.errorsPerHour === null || d.errorsPerHour < 1
              ? 'no 5xx'
              : `${d.errorsPerHour.toFixed(0)}/hour 5xx`
          }
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Storage by repository" icon="▤" span={8}>
          <BarList items={d.byRepo} tone="info" empty="nothing stored" />
          <p className="board-foot">
            A <code>cache/&lt;app&gt;</code> repository is the pull-through copy of an upstream base
            image, not something built here — which is why they usually outweigh the apps
            themselves. Counted separately above for the same reason.
          </p>
        </Board>

        <Board title="Repositories" icon="◲" span={4}>
          <div className="reg-repos">
            {d.repositories.map((r) => (
              <span key={r} className="reg-repo">
                {r}
              </span>
            ))}
            {d.repositories.length === 0 && (
              <p className="viz-empty">
                {d.reachable ? 'nothing published yet' : 'could not read the catalogue'}
              </p>
            )}
          </div>
          <h4 className="board-sub">Cached from upstream</h4>
          <div className="reg-repos">
            {d.cachedRepos.map((r) => (
              <span key={r} className="reg-repo is-muted">
                {r}
              </span>
            ))}
            {d.cachedRepos.length === 0 && <p className="viz-empty">none</p>}
          </div>
        </Board>

        <Board title="Pulls since zot started" icon="↓" span={8}>
          <BarList items={d.pulls} empty="no pulls recorded" />
          <p className="board-foot">
            Each app’s deploy timer pulls by tag every two minutes and restarts only when the digest
            actually moved, so these climb steadily on a box where nothing is being deployed. A flat
            counter is the thing worth noticing, not a large one.
          </p>
        </Board>

        <Board title="How it is reached" icon="⇢" span={4}>
          <Facts
            list
            rows={[
              { k: 'hostname', v: <code>{REGISTRY_HOST}</code> },
              { k: 'read', v: 'anonymous' },
              { k: 'push', v: 'htpasswd, from sops' },
              { k: 'pulled by', v: 'app deploy timers' },
              { k: 'pushed by', v: 'Actions runners' },
            ]}
          />
          <p className="board-foot">
            Anonymous read is deliberate: it is what lets every deploy work with no credential at
            all, so a token expiry can never stop one. Writing still needs the htpasswd.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'zot' }} title="zot logs" neighbours={ZOT_NEIGHBOURS} />
      </BoardGrid>
    </>
  )
}

/* ── npm registry ─────────────────────────────────────────────────────── */

/**
 * verdaccio's neighbours.
 *
 * Both are here for the same reason: verdaccio can be perfectly healthy and
 * still be wrong, and neither failure shows up in its own log.
 */
const VERDACCIO_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { unit: 'verdaccio-image-build.service' },
    label: 'verdaccio-image-build',
    role: 'builds the image, plugins and all',
    note: 'The image is built here rather than pulled: stock verdaccio plus the OIDC and cached-packages plugins. A plugin whose dependency quietly stopped being installed still produces a working image and a clean boot — the feature is simply missing — so this build log is where that is visible and the container’s is not.',
  },
  {
    source: { container: 'pocket-id' },
    label: 'Pocket ID',
    role: 'the IdP its login plugin talks to',
    note: 'verdaccio-openid fetches the OIDC discovery document once, at plugin load, and does not retry. If the IdP was not serving at that moment, verdaccio comes up with npm login broken and nothing crashes to say so — which is why it is listed in fleet.sso.discoveryConsumers and gated on a real probe of that URL.',
  },
]

export function PackagesView({ d }: { d: PackagesData }) {
  return (
    <>
      <ServiceHead
        logo="/icon-verdaccio.png"
        name="verdaccio"
        version={d.running.version}
        versionNote="the tag nix pinned for the local build"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the base image tag in stacks/verdaccio')}
        lede={
          <>
            A private npm registry, and a pull-through cache for npmjs. Every CI build on this box
            resolves through it, which is what keeps a dependency install off the public internet
            and fast — and what makes it the first thing to check when a build stops resolving.
          </>
        }
        actions={
          <a
            href="https://verdaccio.toscanini.me"
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost"
          >
            ↗ Open
          </a>
        }
      />

      <StatStrip>
        <Stat
          label="Reachable"
          value={d.reachable ? 'yes' : 'no'}
          tone={d.reachable ? 'ok' : 'bad'}
          sub="via its stats plugin"
        />
        <Stat
          label="Published here"
          value={d.published === null ? DASH : num(d.published)}
          sub="opt-in; nothing yet"
        />
        <Stat
          label="Cached"
          value={d.cached === null ? DASH : num(d.cached)}
          sub="packages from npmjs"
        />
        <Stat
          label="Versions held"
          value={d.versions === null ? DASH : num(d.versions)}
          sub="across those packages"
        />
        <Stat
          label="With a tarball"
          value={d.withTarball === null ? DASH : num(d.withTarball)}
          sub="actually on disk"
        />
        <Stat
          label="Requests"
          value={d.requestsPerHour === null ? DASH : d.requestsPerHour.toFixed(0)}
          unit="/hour"
          tone={d.errorsPerHour !== null && d.errorsPerHour >= 1 ? 'warn' : undefined}
          sub={
            d.errorsPerHour === null || d.errorsPerHour < 1
              ? 'no 5xx'
              : `${d.errorsPerHour.toFixed(0)}/hour 5xx`
          }
        />
      </StatStrip>

      <BoardGrid>
        <Board title="What is in it" icon="◳" span={6}>
          <Facts
            rows={[
              { k: 'Published here', v: d.published === null ? DASH : num(d.published) },
              { k: 'Cached from npmjs', v: d.cached === null ? DASH : num(d.cached) },
              { k: 'Versions held', v: d.versions === null ? DASH : num(d.versions) },
              { k: 'With a tarball', v: d.withTarball === null ? DASH : num(d.withTarball) },
              {
                k: 'Several versions',
                v: d.multiVersion === null ? DASH : num(d.multiVersion),
              },
            ]}
          />
          <p className="board-foot">
            A pull-through cache first: a package counts as cached the moment its manifest is
            resolved, which is why that number leads the tarball count — resolving a dependency tree
            records a manifest even when no tarball is ever fetched. Publishing here is opt-in and
            nothing does it yet.
          </p>
        </Board>

        <Board title="How it is reached" icon="⇢" span={6}>
          <Facts
            list
            rows={[
              { k: 'hostname', v: <code>verdaccio.{BASE_DOMAIN}</code> },
              { k: 'exposure', v: 'LAN only' },
              { k: 'login', v: 'Pocket ID (OIDC)' },
              { k: 'upstream', v: <code>registry.npmjs.org</code> },
              {
                k: 'own metrics',
                v: <Chip tone="muted">none</Chip>,
              },
            ]}
          />
          <p className="board-foot">
            The request figures above come from traefik, not from verdaccio: it publishes no
            prometheus endpoint at all — upstream issue #1815, open since 2020 — which is also why
            its Grafana dashboard is built out of proxy metrics.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'verdaccio' }}
          title="verdaccio logs"
          neighbours={VERDACCIO_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/* ── shared ───────────────────────────────────────────────────────────── */

function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [
    { k: 'Running', v: gap.installed, note },
    { k: 'Latest release', v: gap.latest, note: 'newest tag on GitHub' },
  ]
}

function fmtBytes(v: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = v
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u] ?? 'B'}`
}
