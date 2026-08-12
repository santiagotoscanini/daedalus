import type { AiData } from '../../../lib/dashboard/categories/ai'
import { DASH, ms, num, pct, until } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Columns, Measures, Pulse, RankRow } from '../../viz'
import { comparePinned } from './shared'

// ── n8n ────────────────────────────────────────────────────────────────────

type N8nFlow = Extract<AiData, { tab: 'n8n' }>['flows'][number]

/**
 * The states a workflow can be in that change what its numbers mean.
 *
 * Independent, so this returns a list rather than picking one — a workflow can
 * be both stalled and unpublished, and the second would explain the first.
 * Warn for anything wanting a decision; muted for `off`, which is not a fault
 * but the reason the row has no recent runs. Colouring that would make every
 * deliberately-parked workflow look broken.
 */
function badgesFor(f: N8nFlow): { text: string; tone: 'warn' | 'muted'; why?: string }[] {
  const out: { text: string; tone: 'warn' | 'muted'; why?: string }[] = []
  if (f.stalled) out.push({ text: 'stalled', tone: 'warn', why: 'kept a cadence, then missed it' })
  if (f.active === true && f.runs === 0)
    out.push({
      text: 'never run',
      tone: 'warn',
      why: 'switched on and has not fired in the window',
    })
  if (f.unpublished)
    out.push({
      text: 'unpublished',
      tone: 'warn',
      why: 'edited since the version the schedule runs',
    })
  if (f.active === false) out.push({ text: 'off', tone: 'muted', why: 'switched off in n8n' })
  return out
}

export function N8nView({ data }: { data: Extract<AiData, { tab: 'n8n' }> }) {
  const { gap, window: total, daily, flows } = data
  const firstDate = daily[0]?.date ?? ''
  const lastDate = daily[daily.length - 1]?.date ?? ''

  return (
    <>
      <ServiceHead
        logo="/icon-n8n.png"
        name="n8n"
        version={data.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(gap)}
        compare={comparePinned(gap, 'an exact tag in stacks/n8n — bump it there')}
        lede={
          <>
            Scheduled workflows, several of which call the gateway. Nothing here runs on a person
            being awake, which is why a failed run is worth seeing on a dashboard.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://n8n.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open n8n ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.n8n.io/' },
          { label: 'Releases', href: 'https://github.com/n8n-io/n8n/releases' },
        ]}
      />

      {/* No headline band, for the same reason the gateway lost its: three of
          the four cards were counts of things listed a few pixels below, and
          the fourth repeated the version verdict already in the header. */}
      <BoardGrid>
        <Board
          title="Runs"
          icon="⟳"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={total.running > 0} tone="accent" />
              {total.running > 0 ? `${num(total.running)} running` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: `${String(total.days)} days`, v: `${num(total.runs)} runs` },
              {
                k: 'failed',
                v:
                  total.runs === 0
                    ? DASH
                    : `${num(total.failed)} · ${pct((total.failed / total.runs) * 100, 1)}`,
                tone: total.failed > 0 ? 'bad' : undefined,
              },
              { k: 'typical run', v: ms(total.medianMs) },
              { k: 'workflows seen', v: String(flows.length) },
            ]}
          />

          <Columns
            points={daily.map((d) => ({
              // Month-day only: the year is the same for every column.
              label: d.date.slice(5),
              value: d.runs,
              display: `${num(d.runs)} run${d.runs === 1 ? '' : 's'}${d.failed > 0 ? ` · ${num(d.failed)} failed` : ''}`,
              flag: d.failed > 0,
            }))}
            height={112}
            empty={data.note ?? 'no executions in the window'}
          />
          {daily.length > 0 && (
            <p className="colaxis">
              <span>{firstDate.slice(5)}</span>
              <span>runs per day</span>
              <span>{lastDate.slice(5)}</span>
            </p>
          )}

          {/* Few enough to name, which is the whole point of naming them: one
              failure a fortnight is a thing to go and read, not a rate. */}
          {data.failures.length > 0 && (
            <p className="rejected">
              {data.failures.map((f, i) => (
                <span key={`${f.name}-${String(i)}`}>
                  {i > 0 && ' · '}
                  <b>{f.name}</b> failed {f.ago}
                </span>
              ))}
            </p>
          )}

          <p className="board-foot">
            Counted from n8n’s own execution history, which it prunes on a schedule — so this window
            is what n8n still holds, and an empty column early on may be forgetting rather than
            silence. A day that saw a failure is underlined in red; the stack trace is behind the
            Executions tab.
            {data.partial &&
              ' There were more executions than this fetched, so these are a lower bound.'}
          </p>
        </Board>

        <Board
          title="Workflows"
          icon="◫"
          span={4}
          aside={<span className="board-note">runs, {total.days}d</span>}
        >
          {flows.length === 0 ? (
            <p className="viz-empty">{data.note ?? 'nothing has run in the window'}</p>
          ) : (
            <ul className="ranks">
              {flows.map((f) => (
                <RankRow
                  key={f.id}
                  name={f.name ?? f.id.slice(0, 8)}
                  note={f.name === null ? `ran in this window, and no longer exists` : null}
                  badges={badgesFor(f)}
                  value={f.runs}
                  max={flows[0]?.runs ?? 1}
                  meta={
                    f.runs === 0 ? (
                      <span className="bad-text">nothing in {total.days} days</span>
                    ) : (
                      <>
                        {f.medianMs !== null && <span>{ms(f.medianMs)}</span>}
                        {/* `until`, not `ms`: a cadence is a period, and the
                            latency formatter tops out at minutes — a daily
                            schedule read "1440m 0s". */}
                        {f.everyMs !== null && <span>every {until(f.everyMs / 1000)}</span>}
                        {f.failed > 0 && <span className="bad-text">{num(f.failed)} failed</span>}
                        <span>{f.ago}</span>
                      </>
                    )
                  }
                />
              ))}
            </ul>
          )}

          <p className="board-foot">
            {/* Three of the four badges are states nothing else reports: a
                schedule that quietly stopped, a workflow switched on that has
                never fired, and a draft that has drifted ahead of what the
                schedule actually runs. None of them produces an error. */}
            Everything that ran in the window, plus everything switched on that should have.{' '}
            <b>stalled</b> kept a cadence and has since missed more than two of them;{' '}
            <b>never run</b> is on and has not fired at all; <b>unpublished</b> has been edited
            since it was last published, so the runs above it are the old version — that one is why
            &ldquo;I changed it and nothing happened&rdquo;. <b>off</b> is switched off and explains
            the silence rather than reporting it.
            {data.archived > 0 &&
              ` ${String(data.archived)} archived workflow${data.archived === 1 ? '' : 's'} are left out — they cannot run.`}
            {data.nameNote !== null && ` ${data.nameNote}`}
          </p>
        </Board>

        <Changelog gap={gap} />

        {/* No neighbours, same bar: pg is the whole box's, and the gateway
            its AI steps call has a tab of its own. */}
        <LogBoard source={{ container: 'n8n' }} title="n8n logs" />
      </BoardGrid>
    </>
  )
}
