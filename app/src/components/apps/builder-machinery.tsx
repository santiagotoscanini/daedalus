// Apps › Builder: the machinery under the builds.

import { cn } from '../../lib/cn'
import { bytes, DASH } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { Ago } from '../ago'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../tokens'
import { Board, Chip, Facts, Progress } from '../viz'
import type { Builder } from './builder'

/* ── machinery ────────────────────────────────────────────────────────── */

type Machinery = Builder['machinery']
type BuilderUnit = NonNullable<Machinery['facts']>['units'][number]

const MISSING: Record<NonNullable<Machinery['missing']>, string> = {
  absent: 'The builder snapshot has not been published.',
  broken: 'The builder snapshot could not be read.',
  stale: 'The builder snapshot has stopped refreshing.',
}

/** A check's verdict: the healthy answer is quiet text, the fault a red chip. */
const yes = (v: boolean | null, ok: string, bad: string) =>
  v === null ? (
    <Chip>unknown</Chip>
  ) : v ? (
    <span className="text-muted-foreground">{ok}</span>
  ) : (
    <Chip tone="bad">{bad}</Chip>
  )

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
                  <span className="inline-flex items-center gap-2">
                    <span className={MONO}>{f.storage.dataset || DASH}</span>
                    {yes(f.storage.mounted, 'mounted', 'NOT mounted')}
                  </span>
                ),
              },
              {
                k: 'Used',
                v: (
                  <span className="inline-flex items-center gap-2.5 tabular-nums">
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
                {unitTone(u) === 'ok' || unitTone(u) === 'muted' ? (
                  // Running or cleanly exited is the norm: quiet text. Only a
                  // failure or a unit mid-transition keeps its chip.
                  <span className="whitespace-nowrap text-[0.75rem] text-muted-foreground">
                    {u.active}
                    {u.sub === '' ? '' : ` · ${u.sub}`}
                  </span>
                ) : (
                  <Chip tone={unitTone(u)}>
                    {u.active}
                    {u.sub === '' ? '' : ` · ${u.sub}`}
                  </Chip>
                )}
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
