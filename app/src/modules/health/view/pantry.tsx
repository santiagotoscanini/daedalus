import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { CAPTION, FOOT, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Measures } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { HealthData } from '../data'
import { gapTitle, VersionAside } from './shared'

// Health › Pantry: Grocy — stock past its date, and the chores and tasks lists —
// and the MCP server that lets a model read and write the same stock.

type Pantry = Extract<HealthData, { tab: 'pantry' }>

export function PantryView({ data: d }: { data: Pantry }) {
  const alarm = (d.overdue ?? 0) + (d.expired ?? 0)
  const listsEmpty = d.chores.total === 0 && d.tasks.total === 0

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
            Household stock, chores and tasks: what food is in the house, and what is about to go
            off. A PHP-FPM image, so it is one of the containers that refuse to run as container
            root and keep the linuxserver default uid instead.
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
              { k: 'Due in 3 days', v: num(d.due) },
              { k: 'Overdue', v: num(d.overdue), tone: (d.overdue ?? 0) > 0 ? 'warn' : undefined },
              { k: 'Expired', v: num(d.expired), tone: (d.expired ?? 0) > 0 ? 'warn' : undefined },
              { k: 'Missing from stock', v: num(d.missing) },
            ]}
          />
          <p className={alarm > 0 ? CAPTION : FOOT}>
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
          <Measures
            items={[
              { k: 'Chores tracked', v: num(d.chores.total) },
              {
                k: 'Chores overdue',
                v: num(d.chores.overdue),
                tone: (d.chores.overdue ?? 0) > 0 ? 'warn' : undefined,
              },
              { k: 'Open tasks', v: num(d.tasks.total) },
              {
                k: 'Tasks overdue',
                v: num(d.tasks.overdue),
                tone: (d.tasks.overdue ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          {listsEmpty && (
            <p className={CAPTION}>Both lists are empty. The stock half is what it is used for.</p>
          )}
        </Board>

        <Changelog gap={d.gap} span={12} />
        <Changelog
          gap={d.mcp.gap}
          span={12}
          title={gapTitle('Grocy MCP', d.mcp.gap)}
          aside={<VersionAside version={d.mcp.version} />}
          foot={
            <p className={FOOT}>
              The same stock as a tool server on the LLM gateway, so a model can check what is in
              the house or add a purchase. What models called it is in the tool counts on AI ›
              Gateway.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'grocy' }}
          title="Grocy logs"
          neighbours={[
            {
              source: { container: 'mcp-grocy' },
              label: 'Grocy MCP',
              role: 'the tool server in front of it',
              note: 'It reaches Grocy’s API with its own key, so a model’s failed stock call shows here first and only then, if at all, in Grocy’s own log.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
