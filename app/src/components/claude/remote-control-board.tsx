// The Remote control board: what the server is, what it holds, and the two
// verbs that act on it.
import type { ClaudeData } from '../../lib/dashboard/claude'
import { bytes, DASH, duration, num, text } from '../../lib/format'
import { Until } from '../ago'
import { FOOT, MONO, NOTE, ROW_SIDE } from '../tokens'
import { Board, Chip, Facts, type Tone } from '../viz'
import { RestartServerControl } from './controls/restart-server'
import { UpdateClaudeCodeControl } from './controls/update-claude-code'

export function RemoteControlBoard({
  data,
  live,
}: {
  data: ClaudeData
  /** Sessions connected right now. */
  live: number
}) {
  const { facts } = data
  const envId = facts.remote.environmentId
  return (
    <Board
      title="Remote control"
      icon="panels"
      span={6}
      aside={
        <span className={NOTE}>
          {facts.remote.spawnMode === null ? 'not announced' : facts.remote.spawnMode}
        </span>
      }
    >
      <Facts
        list
        rows={[
          { k: 'Server', v: <ServerState data={data} /> },
          {
            k: 'Environment',
            v: <span className={MONO}>{text(envId)}</span>,
          },
          {
            k: 'Capacity',
            v: `${num(live)} / ${facts.remote.maxSessions === null ? DASH : num(facts.remote.maxSessions)}`,
          },
          { k: 'Default model', v: <span className={MONO}>{text(facts.settings.model)}</span> },
          { k: 'Effort', v: text(facts.settings.effortLevel) },
          { k: 'Plan', v: text(facts.credentials.subscriptionType) },
          {
            k: 'Re-login due',
            v:
              facts.credentials.refreshExpiresAt === null ? (
                DASH
              ) : (
                <Until at={facts.credentials.refreshExpiresAt} />
              ),
          },
          {
            k: 'Memory',
            v: bytes(facts.server.memoryBytes),
          },
          {
            k: 'CPU',
            v: facts.server.cpuNsec === null ? DASH : duration(facts.server.cpuNsec / 1e9),
          },
        ]}
      />
      <p className={FOOT}>
        The environment id is what a phone connects to, and it is minted per server start — the link
        in the header carries it, so a restart changes the link and the old one stops resolving.
        Spawn mode <span className={MONO}>same-dir</span> means a session started from claude.ai
        lands in the configuration checkout, with the permission matrix and{' '}
        <span className={MONO}>bash-guard.sh</span> in force exactly as they are on the console.
        Memory and CPU are the whole unit including every session under it, which is why they are
        large.
      </p>
      {/* The two verbs, in the order they are used: move the binary,
          then put the running server onto it. Together rather than on
          Updates, because the version compare they act on is in this
          page's header and the restart has always lived here. */}
      <UpdateClaudeCodeControl
        pinned={facts.cli.version}
        latest={data.gap.latest}
        behind={data.gap.behind.length}
      />
      <RestartServerControl live={live} reporting={data.reporting} />
    </Board>
  )
}

const STATE_TONE: Record<string, Tone> = {
  running: 'ok',
  starting: 'warn',
  waiting: 'warn',
  'not-run': 'muted',
  'no-report': 'muted',
  off: 'muted',
}

function ServerState({ data }: { data: ClaudeData }) {
  const { state, detail, restarts } = data.facts.server
  return (
    <>
      <Chip tone={STATE_TONE[state] ?? 'bad'}>{state}</Chip>
      {/* With no report the notice at the top already says why. */}
      {data.reporting && detail !== null && <span className={ROW_SIDE}>{detail}</span>}
      {restarts !== null && restarts > 0 && (
        <span className={ROW_SIDE}>
          {num(restarts)} restart{restarts === 1 ? '' : 's'}
        </span>
      )}
    </>
  )
}
