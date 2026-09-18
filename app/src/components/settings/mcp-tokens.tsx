import { useRouter } from '@tanstack/react-router'
import { KeyRoundIcon } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import type { McpTokenRow } from '../../host/mcp/tokens'
import { when } from '../../lib/format'
import { MCP_TOOLS, type McpScope } from '../../lib/mcp'
import { errorText } from '../../lib/redact'
import { mintMcpTokenFn, revokeMcpTokenFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { ERROR_NOTE, FIELD_LABEL, Mono, NOTE, PANEL, Section, Unset } from './shared'

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
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState<McpScope>('read')
  const [busy, start] = useTransition()
  const [minted, setMinted] = useState<{ label: string; token: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mint = () => {
    if (label.trim() === '') return
    setError(null)
    start(async () => {
      try {
        const r = await mintMcpTokenFn({ data: { label: label.trim(), scope } })
        if (r.ok) {
          setMinted({ label: r.value.row.label, token: r.value.token })
          setLabel('')
          await router.invalidate()
        } else setError(r.reason)
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  const revoke = (id: string) => {
    setError(null)
    start(async () => {
      try {
        const r = await revokeMcpTokenFn({ data: { id } })
        if (!r.ok) setError(r.reason)
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
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
        <div className={PANEL}>
          <p className="m-0 font-medium text-[0.82rem]">
            Copy this now. It is not stored and cannot be shown again.
          </p>
          <Mono className="block break-all rounded-[6px] bg-(--panel-2) p-2 select-all">
            {minted.token}
          </Mono>
          <p className={NOTE}>
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

      <div className={PANEL}>
        <label className={FIELD_LABEL} htmlFor={labelId}>
          Label
        </label>
        <Input
          id={labelId}
          value={label}
          placeholder="claude-code"
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className={NOTE}>
          Names the holder, and becomes the actor of everything the token writes — a build row, a
          commit, a journal line.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={scope === 'read' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setScope('read')}
          >
            read ({READS} tools)
          </Button>
          <Button
            variant={scope === 'write' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setScope('write')}
          >
            write ({READS + WRITES} tools)
          </Button>
          <Button size="sm" disabled={busy || label.trim() === ''} onClick={mint}>
            Mint
          </Button>
        </div>
        <p className={NOTE}>
          {scope === 'read'
            ? 'Reads only: the registry, builds, deploys, image freshness, DNS, the site document and what an Apply would carry.'
            : `Reads plus the ${String(WRITES)} mutations — build, cancel, deploy, image pin, Apply. The same doors the buttons here use, and no others.`}
        </p>
      </div>

      {error !== null && <p className={ERROR_NOTE}>{error}</p>}

      {tokens.length === 0 ? (
        <p className={NOTE}>
          No tokens. Until one is minted, <Mono>/mcp</Mono> refuses every request.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 border-(--border-soft) border-b pb-2 last:border-0"
            >
              <span className="inline-flex flex-col gap-[0.1rem]">
                <span className="inline-flex items-center gap-2">
                  <Mono>{t.label}</Mono>
                  <Chip tone={t.revokedAt !== null ? 'muted' : t.scope === 'write' ? 'warn' : 'ok'}>
                    {t.revokedAt !== null ? 'revoked' : t.scope}
                  </Chip>
                </span>
                <span className="text-[0.72rem] text-(--dim)">
                  minted {when(t.createdAt)} ·{' '}
                  {t.lastUsedAt === null ? 'never used' : `last used ${when(t.lastUsedAt)}`}
                </span>
              </span>
              {t.revokedAt === null ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => revoke(t.id)}>
                  Revoke
                </Button>
              ) : (
                <Unset label={`revoked ${when(t.revokedAt)}`} />
              )}
            </li>
          ))}
        </ul>
      )}

      <p className={NOTE}>
        {live.length === 0
          ? 'Nothing can call the MCP server right now.'
          : `${String(live.length)} live token${live.length === 1 ? '' : 's'}. Revoking is immediate: the next call is refused.`}
      </p>
    </Section>
  )
}
