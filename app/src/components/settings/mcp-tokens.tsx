import { KeyRoundIcon } from 'lucide-react'
import { useId, useState } from 'react'
import type { McpTokenRow } from '../../host/mcp/tokens'
import { cn } from '../../lib/cn'
import { MCP_TOOLS, type McpScope } from '../../lib/mcp'
import { mintMcpTokenFn, revokeMcpTokenFn } from '../../server/settings'
import { When } from '../ago'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from '../tokens'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import { INSET, NOTE_SHOWN } from './form'
import { ERROR_NOTE, FIELD_LABEL, Mono, NOTE, Section, Unset } from './shared'

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
      icon={<KeyRoundIcon />}
      description={
        <>
          The credential an agent presents to <Mono>/mcp</Mono>. LAN only — this box publishes no
          public route to the control plane.
        </>
      }
    >
      {minted !== null && (
        <div className={INSET}>
          <p className="m-0 text-[0.84rem] [font-weight:560]">
            Copy this now. It is not stored and cannot be shown again.
          </p>
          <Mono className="block break-all rounded-lg border border-hairline bg-foreground/[0.05] px-3 py-2 select-all">
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
      )}

      <div className={INSET}>
        <div className="flex flex-col gap-1.5">
          <label className={FIELD_LABEL} htmlFor={labelId}>
            Label
          </label>
          <Input
            id={labelId}
            value={label}
            className="max-w-[24rem]"
            placeholder="claude-code"
            maxLength={64}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <p className={NOTE}>
          Names the holder, and becomes the actor of everything the token writes — a build row, a
          commit, a journal line.
        </p>
        <div className="flex flex-wrap items-center gap-3">
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
          <Button size="sm" disabled={busy || label.trim() === ''} onClick={mint}>
            Mint
          </Button>
        </div>
        <p className={NOTE_SHOWN}>
          {scope === 'read'
            ? 'Reads only: the registry, builds, deploys, image freshness, DNS, the site document and what an Apply would carry.'
            : `Reads plus the ${String(WRITES)} mutations — build, cancel, deploy, image pin, Apply. The same doors the buttons here use, and no others.`}
        </p>
      </div>

      {error !== null && <p className={ERROR_NOTE}>{error}</p>}

      {tokens.length === 0 ? (
        <p className={NOTE_SHOWN}>
          No tokens. Until one is minted, <Mono>/mcp</Mono> refuses every request.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 border-hairline border-t py-2.5 first:border-t-0 first:pt-0"
            >
              <span className="inline-flex flex-col gap-[0.1rem]">
                <span className="inline-flex items-center gap-2">
                  <Mono>{t.label}</Mono>
                  <Chip tone={t.revokedAt !== null ? 'muted' : t.scope === 'write' ? 'warn' : 'ok'}>
                    {t.revokedAt !== null ? 'revoked' : t.scope}
                  </Chip>
                </span>
                <span className="text-[0.72rem] text-muted-foreground">
                  minted {<When at={t.createdAt} />} ·{' '}
                  {t.lastUsedAt === null ? (
                    'never used'
                  ) : (
                    <>
                      last used <When at={t.lastUsedAt} />
                    </>
                  )}
                </span>
              </span>
              {t.revokedAt === null ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(t.id)}>
                  Revoke
                </Button>
              ) : (
                <Unset
                  label={
                    <>
                      revoked <When at={t.revokedAt} />
                    </>
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className={NOTE_SHOWN}>
        {live.length === 0
          ? 'Nothing can call the MCP server right now.'
          : `${String(live.length)} live token${live.length === 1 ? '' : 's'}. Revoking is immediate: the next call is refused.`}
      </p>
    </Section>
  )
}
