import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, duration, num, pct } from '../../../lib/format'
import type { DatabaseData } from '../data'

/* ── Garage ───────────────────────────────────────────────────────────── */

type Garage = Extract<DatabaseData, { tab: 'garage' }>

/** Bucket figures are copied every five minutes; past this they are stale. */
const STALE_AFTER_S = 20 * 60

export function GarageView({ d }: { d: Garage }) {
  const used =
    d.totals.diskAvail !== null && d.totals.diskTotal !== null && d.totals.diskTotal > 0
      ? ((d.totals.diskTotal - d.totals.diskAvail) / d.totals.diskTotal) * 100
      : null
  const stale = d.bucketsAge !== null && d.bucketsAge > STALE_AFTER_S

  return (
    <>
      <ServiceHead
        logo="/icon-garage.svg"
        name="Garage"
        version={d.gap.installed ?? d.version}
        versionNote="reported by the store itself"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from Garage’s own forge')}
        lede={
          <>
            One S3 store, every app with Object storage a tenant with its own bucket and its own
            key. Apps reach it on its bridge and serve their files through their own routes; nothing
            here is public.
          </>
        }
        actions={<Open name="the console" host="garage" />}
      />

      <BoardGrid>
        <Board
          title="The store"
          icon="◱"
          span={8}
          aside={
            <span className={NOTE}>
              {num(d.buckets.length)} buckets · {num(d.totals.objects)} objects
            </span>
          }
        >
          <Measures
            items={[
              { k: 'stored', v: bytes(d.totals.bytes) },
              { k: 'disk used', v: pct(used, 0) },
              { k: 'requests / hour', v: num(d.totals.requestsPerHour) },
              { k: 'server errors / hour', v: num(d.totals.errorsPerHour) },
            ]}
          />
          <p className={FOOT}>
            One node, one copy of every block, metadata and blocks in one dataset — so a single
            snapshot holds both from the same instant, and the box’s snapshots and its mirror to the
            data pool are the store’s backups. <b>Stored</b> counts what apps wrote, before
            deduplication. Apps dial <span className={MONO}>garage:3900</span>; your own tools reach
            the same API on the LAN at{' '}
            <span className={MONO}>{d.s3Url.replace(/^https:\/\//, '')}</span>, path-style, region{' '}
            <span className={MONO}>garage</span>.
          </p>
        </Board>

        <Board title="Serving" icon="◍" span={4}>
          <Facts
            rows={[
              {
                k: 'Cluster',
                v:
                  d.available === null ? (
                    DASH
                  ) : d.available ? (
                    'available'
                  ) : (
                    <Chip tone="bad">unavailable</Chip>
                  ),
              },
              {
                k: 'Unreadable blocks',
                v:
                  (d.totals.erroredBlocks ?? 0) > 0 ? (
                    <Chip tone="bad">{num(d.totals.erroredBlocks)}</Chip>
                  ) : (
                    num(d.totals.erroredBlocks)
                  ),
              },
              { k: 'Resync queue', v: num(d.totals.resyncQueue) },
              {
                k: 'Bucket figures',
                v:
                  d.bucketsAge === null ? (
                    DASH
                  ) : stale ? (
                    <Chip tone="warn">{duration(d.bucketsAge)} old</Chip>
                  ) : (
                    `${duration(d.bucketsAge)} old`
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            With one copy of each block there is no other node to heal from, so an{' '}
            <b>unreadable block</b> is an object that cannot be served. The disk is where to look
            first. Bucket sizes come from Garage’s admin API, copied every five minutes; they are
            not scraped live.
          </p>
        </Board>

        <TableSection title="Buckets" aside={`${num(d.buckets.length)} buckets, largest first`}>
          <BucketsTable rows={d.buckets} />
          <p className={FOOT}>
            A bucket is named after its app and holds one key, the app’s, which may read, write and
            set the bucket’s own rules. More than one key means someone granted another by hand.{' '}
            <b>Unfinished</b> uploads are a client that died mid-upload: their parts take space
            until the app aborts them or a lifecycle rule expires them. A bucket whose app was
            removed stays, with its objects, until it is emptied and deleted on purpose.
          </p>
        </TableSection>

        <Changelog
          gap={d.gap}
          title="Garage releases"
          span={12}
          aside={<span className={NOTE}>git.deuxfleurs.fr</span>}
          foot={
            <p className={FOOT}>
              From Garage’s own forge: the GitHub repository is a mirror of the tags and publishes
              no notes. Read each release’s first paragraph before updating. A newer Garage migrates
              the store when it opens it and refuses to be downgraded afterwards, which is why its
              row on Updates asks for its name to be typed.
            </p>
          }
        />

        {d.console !== null && <ConsoleBoard c={d.console} url={d.consoleUrl} />}
        {d.console !== null && (
          <Changelog
            gap={d.console.gap}
            title="garage-ui releases"
            span={12}
            aside={<span className={NOTE}>github.com/Noooste/garage-ui</span>}
            foot={
              <p className={FOOT}>
                The console is a community project, not Deuxfleurs’ own: their admin UI is still a
                pre-release with no bucket browser. A release here changes what an operator can do
                to the store, so read what it adds to the admin API it calls before moving the pin.
              </p>
            }
          />
        )}

        <LogBoard
          source={{ container: 'garage' }}
          title="Garage logs"
          neighbours={[
            ...(d.console === null
              ? []
              : [
                  {
                    source: { container: 'garage-ui' },
                    label: 'Console',
                    role: 'the web console, garage-ui',
                    note: 'Its sign-ins through the identity provider, and every admin call it makes on someone’s behalf. A login refused for a missing group says so here, with the groups the token carried.',
                  },
                ]),
            {
              source: { units: 'garage-.+\\.service' },
              label: 'Bootstraps and exporter',
              role: 'the box’s own glue around the store',
              note: 'The cluster bootstrap (the RPC secret and metrics token, once), one bootstrap per bucket (the bucket, its key, the grant and the lifecycle rule — where an app that cannot reach its bucket goes wrong first), the console’s token, and the five-minute copy of per-bucket usage behind the table above.',
            },
          ]}
          foot={
            <p className={FOOT}>
              Garage logs every S3 and admin request at info: the client, the key id and the path. A
              burst of 403s names the key that was refused; the secret never appears.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * The web console as the service it is: its own version against its own
 * releases, whether it is running, and where to open it. Its logs ride the
 * page's LogBoard as a neighbour; its changelog is the board after this one.
 */
function ConsoleBoard({ c, url }: { c: NonNullable<Garage['console']>; url: string }) {
  const verdict = verdictOf(c.gap)
  return (
    <Board
      title="The console"
      icon="◧"
      span={12}
      aside={
        <a className={NOTE} href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https:\/\//, '')} ↗
        </a>
      }
    >
      <Facts
        rows={[
          {
            k: 'garage-ui',
            v: (
              <span className="flex items-center gap-2">
                <span className={MONO}>{c.gap.installed ?? c.version ?? DASH}</span>
                <Chip tone={verdict.tone}>{verdict.label}</Chip>
              </span>
            ),
          },
          {
            k: 'Status',
            v: c.up === null ? DASH : c.up ? 'running' : <Chip tone="bad">not running</Chip>,
          },
        ]}
      />
      <p className={FOOT}>
        Buckets, keys and an object browser, signed in through the identity provider and open to
        admins only. Everyone it admits is a full admin of the store: its object browser borrows a
        bucket’s own key to read and write objects. Buckets and keys made for apps are declared on
        the box, so a key deleted here is minted again only when its app’s env file is deleted.
      </p>
    </Board>
  )
}

/** Bucket · objects · unfinished · keys · size. The middle steps away first. */
const BUCKET_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1.4fr)_6.5rem_7rem_4rem_minmax(6rem,1fr)] @max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.mid]:hidden'

function BucketsTable({ rows }: { rows: Garage['buckets'] }) {
  return (
    <ul className={TABLE} aria-label="Buckets">
      <li className={cn(BUCKET_GRID, TABLE_HEAD)}>
        <span>Bucket</span>
        <span className="mid text-right">Objects</span>
        <span className="mid text-right">Unfinished</span>
        <span className="mid text-right">Keys</span>
        <span className="text-right">Size</span>
      </li>
      {rows.length === 0 && <li className={TABLE_EMPTY}>no bucket figures yet</li>}
      {rows.map((b) => {
        const lingering = (b.unfinishedUploads ?? 0) > 0
        const extraKeys = (b.keys ?? 1) > 1
        return (
          <li key={b.name} className={cn(BUCKET_GRID, TABLE_ROW_DENSE)}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[0.76rem] text-foreground">{b.name}</span>
              {/* On a phone the middle columns are this line. */}
              <span className="hidden text-[0.75rem] text-muted-foreground tabular-nums @max-[40rem]/table:block">
                {num(b.objects)} objects
                {lingering && (
                  <span className="text-warning"> · {num(b.unfinishedUploads)} unfinished</span>
                )}
              </span>
            </span>
            <span className={cn(CELL_QUIET, 'mid text-right')}>{num(b.objects)}</span>
            <span className={cn(CELL_QUIET, 'mid text-right', lingering && 'text-warning')}>
              {lingering
                ? `${num(b.unfinishedUploads)} · ${bytes(b.unfinishedBytes)}`
                : num(b.unfinishedUploads)}
            </span>
            <span className={cn(CELL_QUIET, 'mid text-right', extraKeys && 'text-warning')}>
              {num(b.keys)}
            </span>
            <span className="text-right text-foreground tabular-nums">
              {bytes(b.bytes)}
              {b.quotaBytes !== null && (
                <span className="text-muted-foreground"> / {bytes(b.quotaBytes)}</span>
              )}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
