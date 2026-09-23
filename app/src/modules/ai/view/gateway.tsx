import { FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../../../components/tokens'
import { Board, BoardGrid, Chip } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { GatewayData } from '../data/gateway'
import { LitellmView } from './litellm'

// The Gateway tab: LiteLLM's page, then its routing table by the machine
// each route forwards to.

const modeWord = (m: string | null): string =>
  m === null
    ? 'chat'
    : m === 'audio_transcription'
      ? 'speech to text'
      : m === 'audio_speech'
        ? 'text to speech'
        : m === 'image_generation'
          ? 'images'
          : m.replace(/_/g, ' ')

export function GatewayView({ data }: { data: GatewayData }) {
  const { routing, machineNames } = data
  const groups = new Map<string, GatewayData['routing']['routes']>()
  for (const r of routing.routes) {
    const key =
      r.daedalus === null ? 'config.yaml' : (machineNames[r.daedalus.node] ?? r.daedalus.node)
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === 'config.yaml' ? 1 : b === 'config.yaml' ? -1 : a.localeCompare(b),
  )

  return (
    <>
      <LitellmView data={data} />
      {data.configured && (
        <BoardGrid>
          <Board
            title="Models by machine"
            icon="grid"
            span={12}
            aside={
              <span className={NOTE}>
                {num(routing.routes.length)} routes ·{' '}
                {num(routing.routes.filter((r) => r.daedalus !== null).length)} written by daedalus
              </span>
            }
          >
            {routing.error !== null && <p className={FOOT}>{routing.error}</p>}
            {ordered.map(([group, routes]) => (
              <div key={group}>
                <p className={SUB}>
                  {group === 'config.yaml'
                    ? 'from config.yaml, kept by hand'
                    : `provided by ${group}`}
                </p>
                <ul className={LIST}>
                  {routes.map((r) => (
                    <li key={`${group}-${r.alias}-${r.id ?? ''}`} className={ROW}>
                      <Chip tone={r.daedalus === null ? 'muted' : 'ok'}>{modeWord(r.mode)}</Chip>
                      <span className={ROW_MAIN}>
                        <b className="font-[550]">{r.alias}</b>
                        <span className={`ml-[0.4rem] ${MONO} text-muted-foreground`}>
                          {r.upstream}
                        </span>
                      </span>
                      <span className={ROW_SIDE}>{r.host ?? 'no api_base'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {routing.routes.length === 0 && routing.error === null && (
              <p className={FOOT}>The gateway publishes no model.</p>
            )}
            <p className={FOOT}>
              A route written by daedalus carries the machine and provider it came from and follows
              the provider's catalog; a route from config.yaml changes with a rebuild.
            </p>
          </Board>
        </BoardGrid>
      )}
    </>
  )
}
