// Health › Record's first board: every piece of getbased that runs here, as a
// table — the app and its relay, then the agent tools one build makes.

import type { ReactNode } from 'react'
import { QuietState, SECTION_SPAN } from '../../../components/modules/parts'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { CAPTION, FOOT, MONO } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { HealthData } from '../data'

type Record_ = Extract<HealthData, { tab: 'record' }>

/* The piece, the version it runs (with its state beside it when there is
   one), and where it answers. The address gives way first. */
const GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]',
  '@max-[44rem]/table:grid-cols-1 @max-[44rem]/table:gap-y-1',
)
const HIDE_NARROW = '@max-[44rem]/table:hidden'

const short = (sha: string | null): string | null => sha?.slice(0, 7) ?? null

type Piece = {
  name: string
  /** The package, when it is not the piece's own name. */
  pkg?: string
  /** A reading about the piece that is not a state: a count. */
  detail?: string
  version: string | null
  where: ReactNode
  /** The same address as plain text, for the phone's second line. */
  addr?: string
  state?: ReactNode
}

function PieceRow({ p }: { p: Piece }) {
  return (
    <li className={cn(GRID, TABLE_ROW)}>
      <div className="min-w-0">
        <div className={CELL_NAME}>{p.name}</div>
        {p.pkg !== undefined && (
          <p className="m-0 text-[0.78rem] text-muted-foreground/85">
            <span className="font-mono text-[0.7rem]">{p.pkg}</span>
            {p.detail !== undefined && <> · {p.detail}</>}
          </p>
        )}
      </div>
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(CELL_MONO, 'flex-none text-[0.78rem] whitespace-nowrap text-foreground')}
        >
          {p.version ?? DASH}
        </span>
        {p.state}
      </span>
      <span className={cn('min-w-0 truncate', HIDE_NARROW)}>{p.where}</span>
      {/* The Address column steps away on a phone; its value takes a full row
          under the piece and its version, as one line that only breaks if it must. */}
      {p.addr !== undefined && (
        <p
          className={cn(
            CELL_MONO,
            'hidden whitespace-normal [overflow-wrap:anywhere] @max-[44rem]/table:block',
          )}
        >
          {p.addr}
        </p>
      )}
    </li>
  )
}

export function PiecesBoard({ d }: { d: Record_ }) {
  const kb = d.agents.rag.health
  const relay = d.relay.gap
  const record: Piece[] = [
    {
      name: 'App',
      pkg: 'getbased',
      version: short(d.build.running),
      where: <span className={CELL_MONO}>{d.url}</span>,
      addr: d.url,
    },
    {
      name: 'Sync relay',
      version: d.relay.version,
      where: <span className={CELL_MONO}>{d.relayUrl}</span>,
      addr: d.relayUrl,
      state:
        relay.latest === null ? undefined : relay.behind.length === 0 ? (
          <QuietState>up to date</QuietState>
        ) : (
          <Chip tone="warn">{relay.latest} available</Chip>
        ),
    },
  ]
  const agents: Piece[] = [
    {
      name: 'Knowledge base',
      pkg: 'getbased-rag',
      version: d.agents.rag.version,
      where: <span className={CELL_MONO}>{d.agents.rag.url}</span>,
      addr: d.agents.rag.url,
      state:
        kb === null ? (
          <Chip tone="bad">not answering</Chip>
        ) : kb.chunks === 0 ? (
          <Chip tone="muted">empty library</Chip>
        ) : undefined,
      detail: kb === null || kb.chunks === 0 ? undefined : `${num(kb.chunks)} chunks`,
    },
    {
      name: 'Library manager',
      pkg: 'getbased-dashboard',
      version: d.agents.library.version,
      where: (
        <a
          className={cn(CELL_MONO, 'hover:text-foreground')}
          href={d.agents.library.url}
          target="_blank"
          rel="noreferrer"
        >
          {d.agents.library.url} ↗
        </a>
      ),
      addr: d.agents.library.url,
    },
    {
      name: 'MCP server',
      pkg: 'getbased-mcp',
      version: d.agents.mcp.version,
      where: <span className={CELL_QUIET}>Getbased on the LLM gateway</span>,
    },
  ]

  return (
    <TableSection title="Where the record lives" className={cn(SECTION_SPAN[12], 'mt-0')}>
      <ul className={TABLE}>
        <li className={cn(GRID, TABLE_HEAD)}>
          <span>Piece</span>
          <span className={HIDE_NARROW}>Version</span>
          <span className={HIDE_NARROW}>Address</span>
        </li>
        <TableGroup title="The record" note="its app and the relay" className="border-t-0" />
        {record.map((p) => (
          <PieceRow key={p.name} p={p} />
        ))}
        <TableGroup
          title="Agent tools"
          note={`one build of getbased-agents · ${short(d.agents.build.running) ?? 'version unknown'}`}
        />
        {agents.map((p) => (
          <PieceRow key={p.name} p={p} />
        ))}
      </ul>

      {/* The page's one finding, stated where it cannot fold away. */}
      <p className={CAPTION}>
        On the server: static files, and the relay&rsquo;s ciphertext. In each browser: the whole
        record.
      </p>
      <p className={FOOT}>
        Every profile is kept in the browser&rsquo;s own storage, so nothing on this page can count,
        size or back it up. A device joins by naming the relay above under Settings › Data ›
        Cross-device sync and pairing with the profile&rsquo;s sync phrase; the relay stores only
        what the devices encrypted, and without that phrase its copy cannot be read. Between syncs,
        a full backup exported from Settings is the only other copy.
      </p>
      <p className={FOOT}>
        The relay is an Evolu CRDT relay: devices push encrypted changes, and it stores and forwards
        what it cannot read. Its owner-scoped storage is under /self on the same hostname, and the
        context gateway — the same release, a second container — under /api.
      </p>
      <p className={FOOT}>
        One commit of the getbased-agents repository builds all three agent tools. The app&rsquo;s
        Knowledge Base is the knowledge base above, at{' '}
        <span className={MONO}>{d.agents.rag.url}/query</span>; documents go in through the library
        manager, which asks for the same key. The MCP server reads what Agent Access publishes
        through the context gateway and decrypts it in its own container.
      </p>
    </TableSection>
  )
}
