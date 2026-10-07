import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { ServiceHead } from '../../../components/service-head'
import { CAPTION, FOOT } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid } from '../../../components/viz'
import type { Tone } from '../../../lib/tone'
import type { HealthData } from '../data'
import { PiecesBoard } from './record-pieces'
import { VersionAside } from './shared'

// Health › Record: getbased — labs, genome, body and history in one record —
// the relay that keeps its copies in step across devices, and the agent tools
// beside it: the context gateway, the knowledge base and its library manager,
// and the MCP server that puts the record on the LLM gateway.

type Record_ = Extract<HealthData, { tab: 'record' }>

function commitVerdict(build: Record_['build']): { label: string; tone: Tone } {
  if (build.running === null || build.note !== null) return { label: 'unknown', tone: 'muted' }
  const n = build.behind.length
  return n === 0 ? { label: 'current', tone: 'ok' } : { label: `${String(n)} behind`, tone: 'warn' }
}

const short = (sha: string | null): string | null => sha?.slice(0, 7) ?? null

export function RecordView({ data: d }: { data: Record_ }) {
  return (
    <>
      <ServiceHead
        logo="/icon-getbased.svg"
        name="getbased"
        version={short(d.build.running)}
        versionNote="a commit on upstream main"
        verdict={commitVerdict(d.build)}
        lede={
          <>
            Labs, DNA, wearables and medical history in one record, with lab PDFs read by the local
            model and reviewed before saving. The record itself lives in each browser.
          </>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <a href={d.url} target="_blank" rel="noreferrer">
              Open getbased ↗
            </a>
          </Button>
        }
      />

      <BoardGrid>
        <PiecesBoard d={d} />

        {/* Three projects, three release cycles: each says what it would
            bring rather than one changelog speaking for all. Full width, so
            no release's section list is cut short. The app's verdict is the
            header's, so its corner carries the version alone. */}
        <Changelog
          build={d.build}
          span={12}
          title="getbased"
          aside={<VersionAside version={short(d.build.running)} />}
        />
        <Changelog
          gap={d.relay.gap}
          span={12}
          title="Relay"
          aside={<VersionAside version={d.relay.version} behind={d.relay.gap.behind.length} />}
        />
        {d.agents.build.behind.length === 0 ? (
          // Nothing to list: one left-aligned line, not a centred empty card.
          <Board
            title="Agents"
            icon="logs"
            span={12}
            aside={<VersionAside version={short(d.agents.build.running)} behind={0} />}
          >
            <p className={CAPTION}>
              {d.agents.build.note ?? 'Nothing new on the branch since this image was built.'}
            </p>
            <p className={FOOT}>
              Commits rather than releases, because this image tracks a branch instead of a tag, so
              this is what a re-pull would actually bring.
            </p>
          </Board>
        ) : (
          <Changelog
            build={d.agents.build}
            span={12}
            title="Agents"
            aside={
              <VersionAside
                version={short(d.agents.build.running)}
                behind={d.agents.build.behind.length}
              />
            }
          />
        )}

        <LogBoard
          source={{ container: 'getbased' }}
          title="getbased logs"
          neighbours={[
            {
              source: { container: 'getbased-relay' },
              label: 'Sync relay',
              role: 'what keeps the devices in step',
              note: 'One line per device connecting and leaving, and a warning when a write is refused for going over a storage quota. A device that will not sync shows here as a connection that closes at once, or as no connection at all.',
            },
            {
              source: { container: 'getbased-context' },
              label: 'Context gateway',
              role: 'where Agent Access publishes',
              note: 'Stores the context a browser encrypted and the relay vouched for; the MCP server reads it back. A refused upload is a signature the relay would not confirm, or an owner over its quota.',
            },
            {
              source: { container: 'getbased-rag' },
              label: 'Knowledge base',
              role: 'what the app and the MCP server search',
              note: 'Each ingest and query, and the embedding model loading on first use. A query that fails here fails in the app as an empty Knowledge Base answer.',
            },
            {
              source: { container: 'getbased-library' },
              label: 'Library manager',
              role: 'how documents get into the knowledge base',
              note: 'Its own requests, and the uploads it forwards to the knowledge base.',
            },
            {
              source: { container: 'mcp-getbased' },
              label: 'MCP server',
              role: 'the record as tools on the LLM gateway',
              note: 'One child process per session, spawned by supergateway. “gateway returned 404” means no browser has published context through Agent Access yet.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
