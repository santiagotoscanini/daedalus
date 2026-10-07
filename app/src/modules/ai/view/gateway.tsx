import { CAPTION, FOOT } from '../../../components/tokens'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { GatewayData } from '../data/gateway'
import { LitellmView } from './litellm'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  PHONE_SUB,
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

/* Alias, kind, upstream. The host is the machine's address and is the same on
   every row of its group, so it is said once, in the group's band, instead of
   on every row. On a phone the kind moves into the alias's meta line and the
   row is one column: the alias, then "kind · upstream" under it. */
const ROUTE_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,2fr)]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)]',
)
const PHONE_HIDE = '@max-[38rem]/table:hidden'

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
              {routing.routes.length > 0 && (
                <li aria-hidden="true" className={cn(ROUTE_GRID, TABLE_HEAD, PHONE_HIDE)}>
                  <span>Published as</span>
                  <span className={PHONE_HIDE}>Kind</span>
                  <span className={PHONE_HIDE}>Upstream model</span>
                </li>
              )}
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
  // One address per machine, so one in the band. A group that does talk to
  // more than one says so on the rows that differ from the first.
  const hosts = [...new Set(routes.map((r) => r.host ?? 'no api_base'))]
  const main = hosts[0] ?? ''
  return (
    <>
      <TableGroup
        title={byHand ? 'config.yaml' : group}
        note={
          <>
            {byHand ? 'kept by hand' : 'written by daedalus'}
            {' · '}
            <span className={cn(hosts.length === 1 && main !== 'no api_base' && CELL_MONO)}>
              {hosts.length === 1 ? main : `${String(hosts.length)} hosts`}
            </span>
          </>
        }
      />
      {routes.map((r) => {
        const host = r.host ?? 'no api_base'
        return (
          <li key={`${group}-${r.alias}-${r.id ?? ''}`} className={cn(ROUTE_GRID, TABLE_ROW)}>
            <div className="min-w-0">
              <span
                className={cn(
                  CELL_NAME,
                  '@max-[38rem]/table:whitespace-normal @max-[38rem]/table:[overflow-wrap:anywhere]',
                  'block',
                )}
                title={r.alias}
              >
                {r.alias}
              </span>
              <p className={PHONE_SUB}>
                {modeWord(r.mode)} · {r.upstream}
                {hosts.length > 1 && host !== main ? ` · ${host}` : ''}
              </p>
            </div>
            <span className={cn(CELL_QUIET, PHONE_HIDE)}>{modeWord(r.mode)}</span>
            <span className={cn(CELL_MONO, PHONE_HIDE)} title={r.upstream}>
              {r.upstream}
              {hosts.length > 1 && host !== main && (
                <span className="block text-muted-foreground/70">{host}</span>
              )}
            </span>
          </li>
        )
      })}
    </>
  )
}
