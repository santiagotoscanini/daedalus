import { CAPTION, FOOT } from '../../../components/tokens'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { GatewayData } from '../data/gateway'
import { LitellmView } from './litellm'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
  TableSection,
} from './shared'

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

/* Alias, kind, upstream, host. The host repeats down a machine's group (one
   machine, one address), so it is the first to go and quiet while it stays. */
const ROUTE_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1.8fr)_minmax(0,1fr)]',
  '@max-[52rem]/table:grid-cols-[minmax(0,1.2fr)_7rem_minmax(0,1.6fr)]',
  '@max-[36rem]/table:grid-cols-[minmax(0,1fr)_7rem]',
)
const HOST = '@max-[52rem]/table:hidden'
const UPSTREAM = '@max-[36rem]/table:hidden'

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
  const synced = routing.routes.filter((r) => r.daedalus !== null).length

  return (
    <>
      <LitellmView data={data} />
      {data.configured && (
        <div className="mt-10">
          <TableSection
            title="Routes"
            note={`${num(routing.routes.length)} routes, by the machine each forwards to · ${num(synced)} written by daedalus`}
            foot={
              <>
                {routing.error !== null && (
                  <p className={cn(CAPTION, 'text-danger')}>{routing.error}</p>
                )}
                <p className={FOOT}>
                  A route written by daedalus carries the machine and provider it came from and
                  follows the provider's catalog; a route from config.yaml changes with a rebuild.
                </p>
              </>
            }
          >
            <ul className={TABLE} aria-label="Gateway routes">
              <li aria-hidden="true" className={cn(ROUTE_GRID, TABLE_HEAD)}>
                <span>Published as</span>
                <span>Kind</span>
                <span className={UPSTREAM}>Upstream model</span>
                <span className={HOST}>Host</span>
              </li>
              {ordered.map(([group, routes]) => (
                <RouteGroup key={group} group={group} routes={routes} />
              ))}
              {routing.routes.length === 0 && (
                <li className={TABLE_EMPTY}>
                  {routing.error === null
                    ? 'The gateway publishes no model.'
                    : 'Unknown until the gateway answers.'}
                </li>
              )}
            </ul>
          </TableSection>
        </div>
      )}
    </>
  )
}

type Route = GatewayData['routing']['routes'][number]

function RouteGroup({ group, routes }: { group: string; routes: Route[] }) {
  const byHand = group === 'config.yaml'
  return (
    <>
      <TableGroup
        title={byHand ? 'config.yaml' : group}
        note={byHand ? 'kept by hand' : 'written by daedalus'}
      />
      {routes.map((r) => (
        <li key={`${group}-${r.alias}-${r.id ?? ''}`} className={cn(ROUTE_GRID, TABLE_ROW)}>
          <span className={CELL_NAME} title={r.alias}>
            {r.alias}
          </span>
          <span className={CELL_QUIET}>{modeWord(r.mode)}</span>
          <span className={cn(CELL_MONO, UPSTREAM)} title={r.upstream}>
            {r.upstream}
          </span>
          {/* A route with no api_base is the odd one out: it goes wherever the
              provider SDK's default is, not to a machine in the house. */}
          <span className={cn(CELL_MONO, HOST, r.host === null && 'font-sans text-foreground')}>
            {r.host ?? 'no api_base'}
          </span>
        </li>
      ))}
    </>
  )
}
