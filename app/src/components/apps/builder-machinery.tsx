// Apps › Builder: the machinery under the builds, and how GitHub reaches the box.

import { Link } from '@tanstack/react-router'
import { sha7 } from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { bytes, DASH } from '../../lib/format'
import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import type { Tone } from '../../lib/tone'
import { Ago } from '../ago'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../tokens'
import { Board, Chip, Facts, Progress } from '../viz'
import type { Builder } from './builder'
import { BuildStateChip } from './builds'

/* ── machinery ────────────────────────────────────────────────────────── */

type Machinery = Builder['machinery']
type BuilderUnit = NonNullable<Machinery['facts']>['units'][number]

const MISSING: Record<NonNullable<Machinery['missing']>, string> = {
  absent: 'The builder snapshot has not been published.',
  broken: 'The builder snapshot could not be read.',
  stale: 'The builder snapshot has stopped refreshing.',
}

const yes = (v: boolean | null, ok: string, bad: string) =>
  v === null ? <Chip>unknown</Chip> : <Chip tone={v ? 'ok' : 'bad'}>{v ? ok : bad}</Chip>

function unitTone(u: BuilderUnit): Tone {
  if (u.active === 'failed' || (u.result !== null && u.result !== 'success')) return 'bad'
  if (u.active === 'active') return 'ok'
  if (u.active === 'activating' || u.active === 'reloading') return 'info'
  return 'muted'
}

export function MachineryBoard({ m }: { m: Machinery }) {
  const f = m.facts
  const quota = f?.storage.quotaBytes ?? null
  const used = f?.storage.usedBytes ?? null
  return (
    <Board
      title="Machinery"
      icon="logs"
      span={6}
      aside={
        <span className={NOTE}>
          {m.generatedAt === null ? (
            'never published'
          ) : (
            <>
              read <Ago at={m.generatedAt} />
            </>
          )}
        </span>
      }
    >
      {f === null || m.missing !== null ? (
        <p className={EMPTY}>
          {MISSING[m.missing ?? 'absent']} Everything here is unknown until it is.
        </p>
      ) : (
        <>
          <Facts
            list
            rows={[
              {
                k: 'BuildKit daemon',
                v: yes(f.buildkit.reachable, 'answering', 'not answering'),
              },
              {
                k: 'Build cache',
                v: (
                  <span className="tabular-nums">
                    {bytes(f.buildkit.cacheBytes)}
                    <span className="text-muted-foreground">
                      {' '}
                      · {bytes(f.buildkit.reclaimableBytes)} reclaimable
                    </span>
                  </span>
                ),
              },
              {
                k: 'Scratch dataset',
                v: (
                  <span className="inline-flex items-center gap-[0.5rem]">
                    <span className={MONO}>{f.storage.dataset || DASH}</span>
                    {yes(f.storage.mounted, 'mounted', 'NOT mounted')}
                  </span>
                ),
              },
              {
                k: 'Used',
                v: (
                  <span className="inline-flex items-center gap-[0.6rem] tabular-nums">
                    {quota !== null && used !== null && (
                      <span className="w-[6rem]">
                        <Progress
                          pct={(used / quota) * 100}
                          tone={used / quota > 0.85 ? 'warn' : 'accent'}
                        />
                      </span>
                    )}
                    <span>
                      {bytes(used)}
                      {quota !== null && (
                        <span className="text-muted-foreground"> of {bytes(quota)}</span>
                      )}
                    </span>
                  </span>
                ),
              },
              { k: 'Egress fence', v: yes(f.fence.loaded, 'loaded', 'MISSING') },
              { k: 'Push credential', v: yes(f.credential.wellFormed, 'well-formed', 'refused') },
            ]}
          />
          <h4 className={SUB}>Units</h4>
          <ul className={LIST}>
            {f.units.map((u) => (
              <li key={u.unit} className={ROW}>
                <span className={cn(ROW_MAIN, MONO)}>{u.unit}</span>
                <span className={ROW_SIDE}>
                  {u.lastExitAt !== null && (
                    <>
                      last exit <Ago at={u.lastExitAt} />
                    </>
                  )}
                </span>
                <Chip tone={unitTone(u)}>
                  {u.active}
                  {u.sub === '' ? '' : ` · ${u.sub}`}
                </Chip>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={FOOT}>
        Read by the host every minute: the fence and the push credential are the exit codes of their
        own checks — neither the rules nor the password leave the host.
      </p>
    </Board>
  )
}

/* ── GitHub ───────────────────────────────────────────────────────────── */

type Github = Builder['github']

export function GithubBoard({ g }: { g: Github }) {
  const site = useSite()
  const inst = g.installation
  return (
    <Board title="GitHub" icon="logs" span={12}>
      <Facts
        list
        rows={[
          {
            k: 'App installation',
            v:
              inst === null ? (
                <Chip>unknown</Chip>
              ) : (
                <span className="inline-flex items-center gap-[0.5rem]">
                  {inst.account !== null && <span>{inst.account.login}</span>}
                  <Chip tone={inst.state === 'ok' && !inst.stale ? 'ok' : 'warn'}>
                    {inst.stale ? `${inst.state}, stale` : inst.state}
                  </Chip>
                </span>
              ),
          },
          {
            k: 'API budget',
            v:
              g.rateLimit === null ? (
                DASH
              ) : (
                <span className="tabular-nums">
                  {g.rateLimit.remaining.toLocaleString('en-US')} of{' '}
                  {g.rateLimit.limit.toLocaleString('en-US')} left
                </span>
              ),
          },
          {
            k: 'Bad signatures, 24 h',
            v:
              g.rejected24h === null ? (
                DASH
              ) : (
                <span className={cn('tabular-nums', g.rejected24h > 0 && 'text-danger')}>
                  {String(g.rejected24h)}
                </span>
              ),
          },
        ]}
      />
      <h4 className={SUB}>Latest deliveries</h4>
      {g.deliveries.length === 0 ? (
        <p className={EMPTY}>none kept (a week’s worth is)</p>
      ) : (
        <ul className={LIST}>
          {g.deliveries.map((x) => (
            <li key={x.id} className={ROW}>
              <span className={ROW_MAIN}>
                {x.event}
                {x.action === null ? '' : ` · ${x.action}`}
              </span>
              <span className={cn(ROW_SIDE, MONO)}>{x.outcome}</span>
              <span className={ROW_SIDE}>
                <Ago at={x.receivedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
      <h4 className={SUB}>Reported back</h4>
      {g.reported.length === 0 ? (
        <p className={EMPTY}>no build has posted a check run yet</p>
      ) : (
        <ul className={LIST}>
          {g.reported.map((b) => (
            <li key={b.id} className={ROW}>
              <Link
                to="/apps/$name/builds/$id"
                params={{ name: b.app, id: b.id }}
                className={cn(ROW_MAIN, 'no-underline')}
              >
                {b.app} <code className="text-[0.74rem] text-muted-foreground">{sha7(b.sha)}</code>
              </Link>
              <BuildStateChip state={b.state} />
              {b.checkRunId !== null && (
                <a
                  className={ROW_SIDE}
                  href={`https://github.com/${appRepo(site, b.app)}/runs/${String(b.checkRunId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  check run ↗
                </a>
              )}
              {b.deploymentId !== null && (
                <a
                  className={ROW_SIDE}
                  href={`https://github.com/${appRepo(site, b.app)}/deployments`}
                  target="_blank"
                  rel="noreferrer"
                >
                  deployment ↗
                </a>
              )}
              <span className={ROW_SIDE}>{b.reported ? '' : 'not reported'}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Pushes reach the box through the App’s webhook; a delivery with a bad signature is refused
        before anything reads it. Each build reports back as a check run, and a live one as a
        Deployment.
      </p>
    </Board>
  )
}
