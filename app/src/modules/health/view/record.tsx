import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { ServiceHead } from '../../../components/service-head'
import { FOOT, MONO } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH, num } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { HealthData } from '../data'
import { gapTitle, VersionAside } from './shared'

// Health › Record: getbased — labs, genome, body and history in one record —
// the relay that keeps its copies in step across devices, and the agent tools
// beside it: the context gateway, the knowledge base and its library manager,
// and the MCP server that puts the record on the LLM gateway.

type Record_ = Extract<HealthData, { tab: 'record' }>

function commitVerdict(build: Record_['build']): { label: string; tone: Tone } {
  if (build.running === null || build.note !== null) return { label: 'unknown', tone: 'muted' }
  const n = build.behind.length
  return n === 0
    ? { label: 'current', tone: 'ok' }
    : { label: `${String(n)} commits behind`, tone: 'warn' }
}

function commitTitle(label: string, build: Record_['build']): string {
  const n = build.behind.length
  return n === 0 ? `${label} — current` : `${label} — ${String(n)} commits since this build`
}

const short = (sha: string | null): string | null => sha?.slice(0, 7) ?? null

export function RecordView({ data: d }: { data: Record_ }) {
  const kb = d.agents.rag.health
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
            Lab reports, DNA, wearables and medical history in one record, with lab PDFs read by the
            local model and reviewed before they are saved. Static files on the server: the record
            itself lives in each browser that opens it.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href={d.url} target="_blank" rel="noreferrer">
              Open getbased ↗
            </a>
          </Button>
        }
      />

      <BoardGrid>
        <Board title="Where the record lives" icon="◱" span={8}>
          <Facts
            rows={[
              { k: 'App', v: <span className={MONO}>{d.url}</span> },
              { k: 'Sync relay', v: <span className={MONO}>{d.relayUrl}</span> },
              { k: 'On the server', v: 'static files, and the relay’s ciphertext' },
              { k: 'In each browser', v: 'the whole record' },
            ]}
          />
          <p className={FOOT}>
            Every profile is kept in the browser&rsquo;s own storage, so nothing on this page can
            count, size or back it up. A device joins by naming the relay above under Settings ›
            Data › Cross-device sync and pairing with the profile&rsquo;s sync phrase; the relay
            stores only what the devices encrypted, and without that phrase its copy cannot be read.
            Between syncs, a full backup exported from Settings is the only other copy.
          </p>
        </Board>

        <Board title="Sync relay" icon="◔" span={4}>
          <Facts
            rows={[
              { k: 'Version', v: d.relay.version ?? DASH },
              {
                k: 'Latest release',
                v:
                  d.relay.gap.latest === null ? (
                    DASH
                  ) : d.relay.gap.behind.length === 0 ? (
                    <Chip tone="ok">up to date</Chip>
                  ) : (
                    <Chip tone="warn">{d.relay.gap.latest} available</Chip>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            An Evolu CRDT relay: devices push encrypted changes, and it stores and forwards what it
            cannot read. Its owner-scoped storage is under /self on the same hostname, and the
            context gateway — the same release, a second container — under /api.
          </p>
        </Board>

        <Changelog build={d.build} span={6} title={commitTitle('getbased', d.build)} />
        <Changelog
          gap={d.relay.gap}
          span={6}
          title={gapTitle('Relay and context gateway', d.relay.gap)}
          aside={<VersionAside version={d.relay.version} />}
        />

        <Board
          title="Agent tools"
          icon="◇"
          span={6}
          aside={<VersionAside version={short(d.agents.build.running)} />}
        >
          <Facts
            rows={[
              {
                k: 'Knowledge base',
                v: (
                  <>
                    <span className={MONO}>getbased-rag {d.agents.rag.version ?? DASH}</span>{' '}
                    {kb === null ? (
                      <Chip tone="bad">not answering</Chip>
                    ) : kb.chunks === 0 ? (
                      <Chip tone="muted">empty library</Chip>
                    ) : (
                      <Chip tone="ok">{num(kb.chunks)} chunks</Chip>
                    )}
                  </>
                ),
              },
              {
                k: 'Library manager',
                v: (
                  <>
                    <span className={MONO}>
                      getbased-dashboard {d.agents.library.version ?? DASH}
                    </span>{' '}
                    <a href={d.agents.library.url} target="_blank" rel="noreferrer">
                      open ↗
                    </a>
                  </>
                ),
              },
              {
                k: 'MCP server',
                v: (
                  <>
                    <span className={MONO}>getbased-mcp {d.agents.mcp.version ?? DASH}</span> ·
                    Getbased on the LLM gateway
                  </>
                ),
              },
            ]}
          />
          <p className={FOOT}>
            One commit of the getbased-agents repository builds all three. The app&rsquo;s Knowledge
            Base is the knowledge base above, at{' '}
            <span className={MONO}>{d.agents.rag.url}/query</span>; documents go in through the
            library manager, which asks for the same key. The MCP server reads what Agent Access
            publishes through the context gateway and decrypts it in its own container.
          </p>
        </Board>
        <Changelog
          build={d.agents.build}
          span={6}
          title={commitTitle('getbased-agents', d.agents.build)}
        />

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
