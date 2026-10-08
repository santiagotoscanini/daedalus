import { Link } from '@tanstack/react-router'
import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { freshnessRow, LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Facts, Measures, Stat, StatStrip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, ms, num, since, until } from '../../../lib/format'
import type { HermesAgentData } from '../data/hermes-agent'
import { CAPTION, CELL_MONO, comparePinned, EMPTY, FOOT, MONO } from './shared'

// The agent that lives on this box: a chat-and-tools assistant with its own
// gateway key. Every board is a join of facts published elsewhere — see
// data/hermes-agent.ts — so the page says nothing the exports do not.

const MB = 1024 * 1024
const mb = (bytes: number): string => num(Math.round(bytes / MB))

/** The streams the agent writes to files beside its journal, each its own Loki job. */
const STREAMS = [
  { job: 'hermes-agent-gateway', label: 'Gateway', role: 'the messaging gateway’s own log' },
  { job: 'hermes-agent-agent', label: 'Agent', role: 'the agent loop’s own log' },
  { job: 'hermes-agent-errors', label: 'Errors', role: 'what either of them reported as an error' },
] as const

const LIST = 'flex flex-wrap gap-1.5'

export function HermesAgentView({ data }: { data: HermesAgentData }) {
  const { gap, resources: r } = data
  const oom = r.oomKills !== null && r.oomKills > 0

  return (
    <>
      <ServiceHead
        logo="/icon-hermes-agent.png"
        name="Hermes Agent"
        version={data.version}
        versionNote="from the pinned tag"
        verdict={verdictOf(gap, data.freshness)}
        compare={[
          ...comparePinned(gap, 'a digest in the host configuration, against a dated tag'),
          ...freshnessRow(data.freshness),
        ]}
        lede={
          <>
            An agent that answers in chat and acts through tools. It reaches models and tool servers
            only through the gateway, on a key of its own, so this page is that key's ledger and the
            container around it.
          </>
        }
        actions={
          data.url === null ? undefined : (
            <Button asChild size="sm" variant="outline">
              <a href={data.url} target="_blank" rel="noreferrer">
                Open the dashboard ↗
              </a>
            </Button>
          )
        }
      />
      <LinkRow
        links={[{ label: 'GitHub', href: 'https://github.com/NousResearch/hermes-agent' }]}
      />

      <StatStrip>
        <Stat
          label="Health"
          value={data.healthy === null ? 'not probed' : data.healthy ? 'ok' : 'failing'}
          tone={data.healthy === false ? 'bad' : data.healthy === null ? 'muted' : undefined}
          sub={
            data.containerUp === null
              ? 'container unknown'
              : data.containerUp
                ? 'container up'
                : 'container down'
          }
          title="gatus probes the published page every 60s; container_up is the exporter's reading of the process"
        />
        <Stat
          label="CPU"
          value={r.cpu.used === null ? DASH : r.cpu.used.toFixed(2)}
          unit={r.cpu.limit === null ? 'cores' : `of ${String(r.cpu.limit)}`}
          spark={r.cpu.spark}
          tone={r.cpu.used === null ? 'muted' : undefined}
          title="cgroup v2, 60-second resolution"
        />
        <Stat
          label="Memory"
          value={r.memory.used === null ? DASH : mb(r.memory.used)}
          unit={r.memory.limit === null ? 'MB' : `of ${mb(r.memory.limit)}`}
          spark={r.memory.spark}
          tone={r.memory.used === null ? 'muted' : undefined}
          title="memory.current counts page cache: a container doing file I/O sits at its limit and is fine"
        />
        <Stat
          label="Processes"
          value={r.pids.used === null ? DASH : num(r.pids.used)}
          unit={r.pids.limit === null ? '' : `of ${num(r.pids.limit)}`}
          tone={oom ? 'bad' : r.pids.used === null ? 'muted' : undefined}
          sub={oom ? `${num(r.oomKills)} OOM kill${r.oomKills === 1 ? '' : 's'}` : 'no OOM kills'}
        />
      </StatStrip>

      <BoardGrid>
        <UsageBoard data={data} />
        <KeyBoard data={data} />
        <WiringBoard data={data} />
        <JobsBoard data={data} />
        <Changelog gap={gap} span={12} />
        <LogBoard
          source={{ stack: 'hermes-agent' }}
          title="Hermes Agent logs"
          neighbours={STREAMS.map((s) => ({
            source: { job: s.job },
            label: s.label,
            role: s.role,
            note: `The ${s.label.toLowerCase()} file the agent writes inside its state directory, shipped to Loki as job ${s.job}.`,
          }))}
        />
      </BoardGrid>
    </>
  )
}

/** The key's ledger over the gateway's window, from the same read the Gateway tab makes. */
function UsageBoard({ data }: { data: HermesAgentData }) {
  const { gateway: g } = data
  const c = g.caller
  return (
    <Board
      title="Gateway usage"
      icon="logs"
      span={6}
      aside={
        g.configured ? (
          <span className={CAPTION}>{`last ${String(g.days)} days`}</span>
        ) : (
          <Chip tone="muted">no gateway</Chip>
        )
      }
    >
      {!g.configured ? (
        <p className={EMPTY}>No gateway is bound to this box, so there is no ledger to read.</p>
      ) : c === null ? (
        <p className={EMPTY}>
          No request carried the <span className={MONO}>hermes-agent</span> key in the window.
        </p>
      ) : (
        <>
          <Measures
            items={[
              { k: 'Requests', v: num(c.requests) },
              {
                k: 'Failed',
                v: c.failed > 0 ? num(c.failed) : DASH,
                tone: c.failed > 0 ? 'bad' : undefined,
              },
              { k: 'Tokens', v: c.tokens > 0 ? compact(c.tokens) : DASH },
              { k: 'Latency', v: c.latencyMs === null ? DASH : ms(c.latencyMs) },
              { k: 'Cost', v: cost(c.spend) },
            ]}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.72rem] text-muted-foreground">Models reached</span>
            {c.models.length === 0 ? (
              <span className={cn(CELL_MONO, 'truncate')}>{DASH}</span>
            ) : (
              <span className={LIST}>
                {c.models.map((m) => (
                  <Chip key={m}>
                    <span className="font-mono">{m}</span>
                  </Chip>
                ))}
              </span>
            )}
          </div>
        </>
      )}
      <p className={FOOT}>
        Read from the gateway's daily ledger by the key's alias, the same figures the Gateway tab's
        callers list ranks. The cost is what LiteLLM prices the calls at, which for a locally served
        model is zero. Tool calls are counted per server on the Gateway tab, not per caller, so they
        are not split out here.
      </p>
    </Board>
  )
}

/** What the gateway's key table lets this caller reach. The key itself is never read. */
function KeyBoard({ data }: { data: HermesAgentData }) {
  const k = data.gateway.key
  return (
    <Board
      title="What its key may reach"
      icon="logs"
      span={6}
      aside={k === null ? undefined : <span className={CAPTION}>from the gateway’s key table</span>}
    >
      {k === null ? (
        <p className={EMPTY}>
          {data.gateway.configured
            ? 'The gateway holds no key with this alias, or did not answer.'
            : 'No gateway is bound to this box.'}
        </p>
      ) : (
        <Facts
          list
          rows={[
            {
              k: 'Models',
              v:
                k.models.length === 0 ? (
                  'any the gateway serves'
                ) : (
                  <span className={cn(LIST, 'justify-end')}>
                    {k.models.map((m) => (
                      <Chip key={m}>
                        <span className="font-mono">{m}</span>
                      </Chip>
                    ))}
                  </span>
                ),
            },
            {
              k: 'Tool servers',
              v:
                k.mcpServers.length === 0 ? (
                  'none'
                ) : (
                  <span className={cn(LIST, 'justify-end')}>
                    {k.mcpServers.map((s) => (
                      <Chip key={s}>{s}</Chip>
                    ))}
                  </span>
                ),
            },
            {
              k: 'Limits',
              v:
                k.rpmLimit === null && k.tpmLimit === null && k.maxBudget === null
                  ? 'none set'
                  : [
                      k.rpmLimit === null ? null : `${num(k.rpmLimit)} req/min`,
                      k.tpmLimit === null ? null : `${num(k.tpmLimit)} tok/min`,
                      k.maxBudget === null ? null : `$${k.maxBudget.toFixed(2)} budget`,
                    ]
                      .filter((x) => x !== null)
                      .join(' · '),
            },
            { k: 'Last used', v: since(k.lastActiveAgo) },
          ]}
        />
      )}
      <p className={FOOT}>
        A virtual key a model or a tool server is not granted to fails quietly: the model is absent
        from the list the agent sees, and a tool server's tools come back empty rather than refused.
        This is the list to compare against when the agent says it cannot find something.
      </p>
    </Board>
  )
}

/** The exports that describe where it sits: its page, its pin, its sign-in. */
function WiringBoard({ data }: { data: HermesAgentData }) {
  const { pin, sso } = data
  return (
    <Board title="Configuration" icon="logs" span={6}>
      <Facts
        list
        rows={[
          {
            k: 'Dashboard',
            v:
              data.url === null ? (
                'not published'
              ) : (
                <a
                  className="text-foreground underline-offset-2 hover:underline"
                  href={data.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {data.url.replace(/^https:\/\//, '')} ↗
                </a>
              ),
          },
          {
            k: 'Image',
            v:
              pin === null ? (
                'not digest-pinned'
              ) : (
                <span className={MONO} title={pin.digest}>
                  {pin.image}@{pin.digest.replace('sha256:', '').slice(0, 12)}
                </span>
              ),
          },
          {
            k: 'Updates',
            v:
              pin === null ? (
                DASH
              ) : pin.updatable ? (
                <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'updates' }}>
                  System › Updates ↗
                </Link>
              ) : (
                'moved by hand'
              ),
          },
          { k: 'Sign-in', v: sso === null ? 'no OIDC client declared' : sso.displayName },
        ]}
      />
      <p className={FOOT}>
        The dashboard, the pin and the OIDC client come from the publishing, images and sso exports,
        the same files the Network, Updates and Sign-in pages read. Nothing is read from the agent's
        own configuration or credentials.
      </p>
    </Board>
  )
}

/** The scheduled checks registered for it, with the host's last run of each. */
function JobsBoard({ data }: { data: HermesAgentData }) {
  return (
    <Board title="Scheduled checks" icon="logs" span={6}>
      {data.jobs.length === 0 ? (
        <p className={EMPTY}>No scheduled check is registered for it.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {data.jobs.map((j) => {
            const failed = j.result !== null && j.result !== 'success'
            return (
              <li
                key={j.unit}
                className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-hairline border-t py-2 first:border-t-0 first:pt-0"
              >
                <span className={cn(MONO, 'min-w-0 text-foreground')}>{j.unit}</span>
                <span className="flex items-center gap-2 text-[0.78rem] text-muted-foreground tabular-nums">
                  {j.lastRunAgo === null ? (
                    'not run since boot'
                  ) : (
                    <>
                      {since(j.lastRunAgo)}
                      <Chip tone={failed ? 'bad' : 'ok'}>
                        {failed ? (j.result ?? 'failed') : 'ok'}
                      </Chip>
                    </>
                  )}
                  {j.nextIn !== null && <span>next in {until(j.nextIn)}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className={FOOT}>
        Joined from the monitored-jobs export and the host's timer table. A check declared with a
        mail flag mails the operator when a run fails; one with a slug also pages when it stops
        running.
      </p>
    </Board>
  )
}

/** Dollars, to the cent, with a floor so a real but tiny spend is not drawn as nothing. */
function cost(usd: number): string {
  if (usd <= 0) return '$0.00'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}
