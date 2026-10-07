import { useId, useState } from 'react'
import type { McpTokenRow } from '../../host/mcp/tokens'
import { cn } from '../../lib/cn'
import { MCP_TOOLS, type McpScope } from '../../lib/mcp'
import { mintMcpTokenFn, revokeMcpTokenFn } from '../../server/settings'
import { When } from '../ago'
import { CELL_QUIET, CELL_SUB, TABLE_HEAD, TABLE_ROW } from '../table'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from '../tokens'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { Band, CONTROL_H, ERROR_NOTE, INSET, Mono, NOTE, NOTE_SHOWN, Section } from './shared'

// Minting and revoking the credentials that reach /mcp.
//
// ── the one rule this panel exists to enforce ─────────────────────────────
//
// The token is shown ONCE, here, immediately after minting, and is then gone —
// the server stored a SHA-256 digest and cannot produce the value again. So
// the disclosure is deliberately loud and deliberately dismissible only by the
// operator: there is no "reveal" beside a row, because there is nothing to
// reveal. Lose it and mint another.
//
// ── why the scope picker is two radio-ish buttons and not a list ──────────
//
// There are two scopes and there will not be a third (lib/mcp.ts says why), so
// a select would be a widget standing in for a sentence. The sentence is the
// point: `read` reaches the loaders, `write` reaches those plus the five
// mutations, and the counts below come from the same catalogue the server
// registers from, so this panel cannot describe a surface that does not exist.

const READS = MCP_TOOLS.filter((t) => t.scope === 'read').length
const WRITES = MCP_TOOLS.filter((t) => t.scope === 'write').length

export function McpTokens({ tokens }: { tokens: McpTokenRow[] }) {
  const labelId = useId()
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<McpScope>('read')
  const { run, busy, error } = useAction()
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(null)

  const mint = () => {
    if (label.trim() === '') return
    run(() => mintMcpTokenFn({ data: { label: label.trim(), scope } }), {
      onDone: (r) => {
        setMinted({ label: r.value.row.label, token: r.value.token })
        setLabel('')
      },
    })
  }

  const revoke = (id: string) => {
    run(() => revokeMcpTokenFn({ data: { id } }))
  }

  const live = tokens.filter((t) => t.revokedAt === null)

  return (
    <Section
      title="MCP tokens"
      description={
        <>
          The credential an agent presents to <Mono>/mcp</Mono>. LAN only — this box publishes no
          public route to the control plane.
        </>
      }
      aside={
        live.length === 0
          ? 'none live'
          : `${String(live.length)} live token${live.length === 1 ? '' : 's'}`
      }
      body={
        <>
          {minted !== null && (
            <Band>
              <div className={INSET}>
                <p className="m-0 text-[0.84rem] [font-weight:560]">
                  Copy this now. It is not stored and cannot be shown again.
                </p>
                <Mono className="block break-all rounded-lg bg-foreground/[0.06] px-3 py-2 select-all">
                  {minted.token}
                </Mono>
                <p className={NOTE_SHOWN}>
                  For <strong>{minted.label}</strong>. Writes it makes are recorded as{' '}
                  <Mono>mcp:{minted.label}</Mono>.
                </p>
                <div>
                  <Button variant="outline" size="sm" onClick={() => setMinted(null)}>
                    I have copied it
                  </Button>
                </div>
              </div>
            </Band>
          )}

          {/* Minting: a label, a scope and the button on one line, what the
              scope reaches under it. */}
          <Band>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={labelId}>
                Label
              </label>
              <Input
                id={labelId}
                value={label}
                className={cn(CONTROL_H, 'w-[16rem] max-w-full md:text-[0.8125rem]')}
                placeholder="a label, e.g. claude-code"
                maxLength={64}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') mint()
                }}
              />
              {/* One of two: the segmented control, not two buttons that both look pressable. */}
              <fieldset className={cn(SEGMENT_TRACK, 'm-0 min-w-0')} aria-label="Scope">
                <button
                  type="button"
                  aria-pressed={scope === 'read'}
                  className={cn(SEGMENT_ITEM, scope === 'read' && SEGMENT_ITEM_ON)}
                  onClick={() => setScope('read')}
                >
                  read ({READS} tools)
                </button>
                <button
                  type="button"
                  aria-pressed={scope === 'write'}
                  className={cn(SEGMENT_ITEM, scope === 'write' && SEGMENT_ITEM_ON)}
                  onClick={() => setScope('write')}
                >
                  write ({READS + WRITES} tools)
                </button>
              </fieldset>
              <Button
                size="sm"
                className="h-8"
                disabled={busy || label.trim() === ''}
                onClick={mint}
              >
                Mint
              </Button>
            </div>
            <p className={NOTE_SHOWN}>
              {scope === 'read'
                ? 'Reads only: the registry, builds, deploys, image freshness, DNS, the site document and what an Apply would carry.'
                : `Reads plus the ${String(WRITES)} mutations — build, cancel, deploy, image pin, Apply. The same doors the buttons here use, and no others.`}
            </p>
            <p className={NOTE}>
              The label names the holder, and becomes the actor of everything the token writes — a
              build row, a commit, a journal line.
            </p>
            {error !== null && <p className={ERROR_NOTE}>{error}</p>}
          </Band>

          {tokens.length === 0 ? (
            <Band>
              <p className={NOTE_SHOWN}>
                No tokens. Until one is minted, <Mono>/mcp</Mono> refuses every request.
              </p>
            </Band>
          ) : (
            <ul className="m-0 list-none border-hairline border-t p-0">
              <li className={cn(GRID, TABLE_HEAD)}>
                <span>Label</span>
                <span>Scope</span>
                <span className={STEP}>Minted</span>
                <span>Last used</span>
                <span />
              </li>
              {tokens.map((t) => (
                <TokenRow key={t.id} t={t} busy={busy} onRevoke={() => revoke(t.id)} />
              ))}
            </ul>
          )}
        </>
      }
    >
      <p className={NOTE_SHOWN}>
        {live.length === 0
          ? 'Nothing can call the MCP server right now.'
          : 'Revoking is immediate: the next call is refused.'}
      </p>
    </Section>
  )
}

/** Label, scope, minted, last used, the action — one grid for the head and every row. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_4.5rem_12rem_12rem_5.5rem] items-center gap-x-6 px-5 @max-[52rem]/table:grid-cols-[minmax(0,1fr)_4.5rem_12rem_5.5rem]'
/** The column that steps away first. */
const STEP = '@max-[52rem]/table:hidden'

/**
 * One token. A live read token is the norm and stays quiet; a write token
 * says its scope in ink, because it can change the box; a revoked one recedes whole.
 */
function TokenRow({ t, busy, onRevoke }: { t: McpTokenRow; busy: boolean; onRevoke: () => void }) {
  const revoked = t.revokedAt !== null
  return (
    <li className={cn(GRID, TABLE_ROW, revoked && 'text-muted-foreground')}>
      <span className="flex min-w-0 flex-col">
        <Mono className={cn('truncate', !revoked && 'text-foreground')}>{t.label}</Mono>
        {t.revokedAt !== null && (
          <span className={CELL_SUB}>
            revoked <When at={t.revokedAt} />
          </span>
        )}
      </span>
      <span>
        {revoked ? (
          <span className={CELL_QUIET}>revoked</span>
        ) : t.scope === 'write' ? (
          <span className="text-[0.78rem] text-foreground">write</span>
        ) : (
          <span className={CELL_QUIET}>{t.scope}</span>
        )}
      </span>
      <span className={cn(CELL_QUIET, STEP, 'whitespace-nowrap')}>
        <When at={t.createdAt} />
      </span>
      <span className={cn(CELL_QUIET, 'whitespace-nowrap')}>
        {t.lastUsedAt === null ? 'never used' : <When at={t.lastUsedAt} />}
      </span>
      <span className="text-right">
        {!revoked && (
          <Button variant="outline" size="sm" disabled={busy} onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </span>
    </li>
  )
}
