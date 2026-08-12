import type { AiData } from '../../../lib/dashboard/categories/ai'
import { num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { freshnessRow, LinkRow, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Measures, Pulse } from '../../viz'
import { comparePinned } from './shared'

// ── Open WebUI ─────────────────────────────────────────────────────────────

export function OpenWebUiView({ data }: { data: Extract<AiData, { tab: 'open-webui' }> }) {
  const { gap, counts } = data
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
          // Its own update check, which used to be a whole stat card saying
          // "up to date". It is a second opinion on the line above it, so it
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
          <a
            className="btn btn-primary"
            href="https://chat.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open the chat ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.openwebui.com/' },
          { label: 'GitHub', href: 'https://github.com/open-webui/open-webui' },
        ]}
      />

      {/* No headline band. It held four cards, and all four were either a
          number this page states better in context (models offered, sitting a
          few pixels above the list of them) or a number that is zero almost
          always and means nothing when it is not (users seen in the last three
          minutes, on a one-account instance). */}
      <BoardGrid>
        <Board
          title="What the chat can reach"
          icon="rows"
          span={6}
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(data.generating)} mid-answer` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'models', v: String(counts.models) },
              { k: 'tool servers', v: String(counts.tools) },
              { k: 'knowledge', v: String(counts.knowledge) },
            ]}
          />

          {data.reach.length === 0 ? (
            <p className="viz-empty">{data.note ?? 'nothing registered'}</p>
          ) : (
            <ul className="itemlist">
              {data.reach.map((r) => (
                <li key={`${r.kind}-${r.name}`}>
                  <Chip tone={r.kind === 'model' ? 'info' : r.kind === 'tool' ? 'accent' : 'muted'}>
                    {r.kind}
                  </Chip>
                  <span className="item-main">{r.name}</span>
                  <span className={r.flag ? 'item-side bad-text' : 'item-side'} title={r.detail}>
                    {r.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="board-foot">
            Read back from the running instance, not from the config that was meant to produce it —
            which is the only way to catch the two ways these disappear quietly. An env-backed
            setting the database had already overridden leaves the models list short, and a virtual
            key not permitted to reach an MCP server makes its tools return an empty list rather
            than an error. A knowledge base holding no files is marked: it answers nothing, and says
            nothing about it.
          </p>
        </Board>

        {/* Three panels, and the sign-in readback is deliberately not one of
            them. It was four facts that are declared in the stack and change
            when somebody edits nix — an identity provider, a login form that
            is off, a sign-up that is closed — so it could only ever agree with
            what you already wrote. */}
        <Changelog gap={gap} span={6} />

        {/* No neighbours. Everything this app dials either has its own tab
            (LiteLLM), is already folded under that tab (searxng), or is the
            whole box's database. See the bar on `Neighbour`. */}
        <LogBoard source={{ container: 'open-webui' }} title="Open WebUI logs" />
      </BoardGrid>
    </>
  )
}
