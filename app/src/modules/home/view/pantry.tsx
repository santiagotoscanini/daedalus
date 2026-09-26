import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Facts, Measures } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { HomeData } from '../data'
import { FOOT_WARN } from './shared'

// Home › Pantry: Grocy — stock past its date, and the chores and tasks lists.

type Pantry = Extract<HomeData, { tab: 'pantry' }>

export function PantryView({ data: d }: { data: Pantry }) {
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
          aside={<span className={NOTE}>{num(d.inStock)} products on hand</span>}
        >
          <Measures
            items={[
              { k: 'due in 3 days', v: num(d.due) },
              { k: 'overdue', v: num(d.overdue) },
              { k: 'expired', v: num(d.expired) },
              { k: 'missing from stock', v: num(d.missing) },
            ]}
          />
          <p className={alarm > 0 ? FOOT_WARN : FOOT}>
            {alarm > 0 ? (
              <>
                <b>{num(alarm)}</b> products are past their date. Grocy distinguishes the two:{' '}
                <b>overdue</b> is past the best-before and still fine, <b>expired</b> is past the
                use-by. Nothing here alerts. This is the only place it is said.
              </>
            ) : (
              <>
                Nothing is past its date. &ldquo;Missing&rdquo; is a product below its minimum stock
                level rather than one that has run out, which is the list a shopping trip is built
                from.
              </>
            )}
          </p>
        </Board>

        <Board title="Chores & tasks" icon="✓" span={4}>
          <Facts
            rows={[
              { k: 'Chores tracked', v: num(d.chores.total) },
              {
                k: 'Chores overdue',
                v:
                  (d.chores.overdue ?? 0) > 0 ? (
                    <span className="text-warning">{num(d.chores.overdue)}</span>
                  ) : (
                    num(d.chores.overdue)
                  ),
              },
              { k: 'Open tasks', v: num(d.tasks.total) },
              {
                k: 'Tasks overdue',
                v:
                  (d.tasks.overdue ?? 0) > 0 ? (
                    <span className="text-warning">{num(d.tasks.overdue)}</span>
                  ) : (
                    num(d.tasks.overdue)
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Both lists are empty on this instance. The stock half is what it is used for.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'grocy' }} title="Grocy logs" />
      </BoardGrid>
    </>
  )
}
