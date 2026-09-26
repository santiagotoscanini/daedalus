import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Facts, Measures } from '../../../components/viz'
import { bytes, DASH, num, pct } from '../../../lib/format'
import type { HomeData } from '../data'
import { FOOT_WARN } from './shared'

// Home › Files: Nextcloud — sharing (and the links with no password), contents,
// who is using it, and what it runs on.

type Files = Extract<HomeData, { tab: 'files' }>

export function FilesView({ data: d }: { data: Files }) {
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
          aside={<span className={NOTE}>{num(d.shares.total)} shares</span>}
        >
          <Measures
            items={[
              { k: 'public links', v: num(d.shares.link) },
              { k: 'without a password', v: num(d.shares.linkNoPassword) },
              { k: 'to a user', v: num(d.shares.user) },
              { k: 'to a group', v: num(d.shares.group) },
            ]}
          />
          {/* The one fact on this page that is worth acting on. */}
          <p className={openLinks > 0 ? FOOT_WARN : FOOT}>
            {openLinks > 0 ? (
              <>
                <b>{num(openLinks)}</b> of {num(d.shares.link)} public links carry no password, so
                each is a URL that opens the file for anyone holding it. That is how a link share is
                normally used, and sending one to somebody who has no account here is the entire
                point. It also means the count above is the number of files whose security is the
                secrecy of a URL.
              </>
            ) : (
              <>Every public link is password-protected.</>
            )}
          </p>
        </Board>

        <Board title="Contents" icon="rows" span={4}>
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
          <p className={FOOT}>
            Sign-in is Pocket ID only. The login form is hidden, so there is no password on this
            instance to guess or reuse.
          </p>
        </Board>

        <Board title="Underneath" icon="⚙" span={4}>
          <Facts
            rows={[
              {
                k: 'Database',
                v: d.db.type === null ? DASH : `${d.db.type} · ${d.db.version ?? ''}`,
              },
              { k: 'Database size', v: bytes(d.db.sizeBytes) },
              { k: 'PHP', v: d.php.version ?? DASH },
              { k: 'Opcache hit rate', v: pct(d.php.opcacheHitRate, 2) },
              { k: 'Distributed cache', v: (d.cache ?? DASH).replace(/^\\?OC\\Memcache\\/, '') },
            ]}
          />
          <p className={FOOT}>
            The database is a tenant of the shared cluster, not a container of its own. It appears
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
              note: 'The official image ships no ffmpeg, which the preview generator and the recognize app both need, so this builds a local wrapper before the app starts. The tag embeds the build context’s store hash. An unchanged context rebuilds from cache in seconds; a changed one produces a new tag and restarts the container.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
