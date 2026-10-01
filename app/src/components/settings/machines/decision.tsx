import { cn } from '../../../lib/cn'
import type { Machine } from '../../../lib/dashboard/machines'
import { linkWords } from '../../../lib/node-link'
import { approveNodeFn, forgetNodeFn, revokeNodeFn } from '../../../server/nodes'
import { Ago } from '../../ago'
import { NodeCommandButton } from '../../node-command'
import { Button } from '../../ui/button'
import { useAction } from '../../use-action'
import { ERROR_NOTE, MONO, NOTE } from '../shared'

// A machine's trust: waiting, approved or revoked, and the buttons that move
// it between them. A waiting key is the controller's — it has no row until
// it is approved — and its card is where the two fingerprints are compared
// (./index.tsx).

/** The box's decision about the machine, and the buttons that change it. */
export function Decision({ m }: { m: Machine }) {
  const { run, busy, error } = useAction()
  const id = m.node?.id ?? m.pending?.id ?? null
  const act = (fn: (opts: { data: { id: string } }) => Promise<unknown>) => {
    if (id === null) return
    run(() => fn({ data: { id } }))
  }
  const node = m.node

  const line =
    node === null ? (
      <>
        Connected to the controller
        {m.pending?.since != null && (
          <>
            {' '}
            <Ago at={m.pending.since} />
          </>
        )}{' '}
        and waiting for a decision. Approve it if this is your machine and the fingerprints match.
      </>
    ) : node.state === 'approved' ? (
      <>
        Approved {node.approvedAt !== null && <Ago at={node.approvedAt} />}
        {node.approvedBy !== null && ` by ${node.approvedBy}`}; {linkWords(node)}.
      </>
    ) : (
      'Revoked; the controller turns its key away. Approve to trust it again, or forget it.'
    )

  return (
    <div className="flex flex-col gap-2">
      <p className={NOTE}>{line}</p>
      <div className="flex flex-wrap items-center gap-2">
        {node?.state !== 'approved' && (
          <Button size="sm" disabled={busy} onClick={() => act(approveNodeFn)}>
            Approve
          </Button>
        )}
        {node?.state === 'approved' && (
          <>
            <NodeCommandButton id={node.id} command="check_update" label="Update now" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(revokeNodeFn)}>
              Revoke
            </Button>
          </>
        )}
        {node?.state === 'revoked' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(forgetNodeFn)}>
            Forget
          </Button>
        )}
        {id !== null && (
          <span
            className={cn(MONO, 'text-[0.7rem] text-(--dim)')}
            title="sha256 of the machine's public key, the first 16 hex digits: what the box trusts"
          >
            key {id}
          </span>
        )}
      </div>
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </div>
  )
}
