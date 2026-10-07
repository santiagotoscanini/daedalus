import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { freshnessRow, LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { BoardGrid, Pulse } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { OpenWebUiData } from '../data/open-webui'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  comparePinned,
  FOOT,
  LIVE,
  PHONE_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
  TableSection,
} from './shared'

// ── Open WebUI ─────────────────────────────────────────────────────────────

export function OpenWebUiView({ data }: { data: OpenWebUiData }) {
  const { gap } = data
  const busy = data.generating !== null && data.generating > 0

  return (
    <>
      <ServiceHead
        logo="/icon-open-webui.svg"
        name="Open WebUI"
        version={data.version}
        versionNote="the chat window"
        verdict={verdictOf(gap, data.freshness)}
        compare={[
          ...comparePinned(gap, 'a digest in the flake, against a moving main tag'),
          ...freshnessRow(data.freshness),
          // Its own update check: a second opinion on the line above it, so it
          // belongs beside that line — and it only earns a sentence when the
          // two disagree.
          {
            k: 'Its own check',
            v: data.selfLatest,
            note:
              data.selfLatest === null
                ? 'it could not reach GitHub either'
                : data.selfLatest === data.version
                  ? 'agrees: this is current'
                  : 'what the app itself reports as newest',
          },
        ]}
        lede={
          <>
            The one service here a person types into. It talks to LiteLLM like any other OpenAI
            client, so it sees whatever the gateway publishes and nothing more.
          </>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <a href={data.url} target="_blank" rel="noreferrer">
              Open the chat ↗
            </a>
          </Button>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.openwebui.com/' },
          { label: 'GitHub', href: 'https://github.com/open-webui/open-webui' },
        ]}
      />

      {/* No headline band: every candidate figure is either stated better in
          context (models offered, above the list of them) or zero almost
          always on a one-account instance (users seen recently). */}
      <BoardGrid>
        <ReachTable data={data} busy={busy} />

        {/* No sign-in readback — see `loadOpenWebUi`. */}
        <Changelog gap={gap} span={12} />

        {/* No neighbours. Everything this app dials either has its own tab
            (LiteLLM), is already folded under that tab (searxng), or is the
            whole box's database. */}
        <LogBoard source={{ container: 'open-webui' }} title="Open WebUI logs" />
      </BoardGrid>
    </>
  )
}

/* Name, then what it is: a model's id, a tool server's own description, a
   knowledge base's file count. The kind is the group, not a chip per row. */
const REACH_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)]',
)
const KIND_GROUP: Record<OpenWebUiData['reach'][number]['kind'], string> = {
  model: 'Models',
  tool: 'Tool servers',
  knowledge: 'Knowledge',
}

/**
 * What the chat window can reach, read back from the running instance.
 *
 * The counts were a measure line over a list that repeated its kind as a chip
 * on every row; the counts are the note, the kind is the group band.
 */
function ReachTable({ data, busy }: { data: OpenWebUiData; busy: boolean }) {
  const { counts } = data
  const kinds = (['model', 'tool', 'knowledge'] as const).filter((k) =>
    data.reach.some((r) => r.kind === k),
  )
  return (
    <TableSection
      title="What the chat can reach"
      note={`${String(counts.models)} models · ${String(counts.tools)} tool servers · ${String(counts.knowledge)} knowledge`}
      aside={
        <span className={LIVE}>
          <Pulse on={busy} tone="accent" />
          {busy ? `${num(data.generating)} mid-answer` : 'idle'}
        </span>
      }
      foot={
        <p className={FOOT}>
          Read back from the running instance, not from the config that was meant to produce it.
          That is the only way to catch the two ways these disappear quietly. An env-backed setting
          the database had already overridden leaves the models list short, and a virtual key not
          permitted to reach an MCP server makes its tools return an empty list rather than an
          error. A knowledge base holding no files is marked: it answers nothing and reports no
          error.
        </p>
      }
    >
      <ul className={TABLE} aria-label="What the chat can reach">
        {data.reach.length > 0 && (
          <li aria-hidden="true" className={cn(REACH_GRID, TABLE_HEAD)}>
            <span>Name</span>
            <span className="@max-[38rem]/table:hidden">What it is</span>
          </li>
        )}
        {data.reach.length === 0 ? (
          <li className={TABLE_EMPTY}>{data.note ?? 'Nothing registered.'}</li>
        ) : (
          kinds.map((k) => (
            <ReachGroup
              key={k}
              title={KIND_GROUP[k]}
              rows={data.reach.filter((r) => r.kind === k)}
            />
          ))
        )}
      </ul>
    </TableSection>
  )
}

function ReachGroup({ title, rows }: { title: string; rows: OpenWebUiData['reach'] }) {
  return (
    <>
      <TableGroup title={title} />
      {rows.map((r) => (
        <li key={`${r.kind}-${r.name}`} className={cn(REACH_GRID, TABLE_ROW)}>
          <div className="min-w-0">
            <span
              className={cn(
                CELL_NAME,
                'block @max-[38rem]/table:whitespace-normal @max-[38rem]/table:[overflow-wrap:anywhere]',
              )}
            >
              {r.name}
            </span>
            <p className={cn(PHONE_SUB, r.flag && 'text-danger')}>{r.detail}</p>
          </div>
          <span
            className={cn(
              r.kind === 'model' ? CELL_MONO : CELL_QUIET,
              'truncate @max-[38rem]/table:hidden',
              r.flag && 'text-danger',
            )}
            title={r.detail}
          >
            {r.detail}
          </span>
        </li>
      ))}
    </>
  )
}
