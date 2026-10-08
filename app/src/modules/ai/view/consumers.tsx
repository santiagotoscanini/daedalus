import { Link } from '@tanstack/react-router'
import { CAPTION, FOOT } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { ConsumersData } from '../data/consumers'
import { N8nView } from './n8n'
import { OpenWebUiView } from './open-webui'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  PHONE_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
  TableSection,
} from './shared'

// The Consumers tab: what calls the gateway. The apps that hold a key are a
// table, each row the way to that app's own page; Open WebUI and n8n keep the
// pages they had, one under the other.

/* The stacked service pages each open with their own ServiceHead, which
   already names the service; the break between them is air and a hairline,
   not a third heading saying the name again. */
const BREAK = 'mt-8 border-hairline border-t pt-8'

const APP_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_8rem]',
)

export function ConsumersView({ data }: { data: ConsumersData }) {
  return (
    <>
      <BoardGrid>
        <TableSection
          title="Apps holding a gateway key"
          note={`${num(data.apps.length)} of the box's apps${
            data.agents.length === 0 ? '' : ` · ${num(data.agents.length)} on a page of its own`
          }`}
          foot={
            <p className={FOOT}>
              A key per app, minted by the box and rotated with the app (Hermes Agent's is a virtual
              key on the gateway); what each key may call is the gateway's policy, and the Gateway
              tab's callers list is who actually did.
            </p>
          }
        >
          <ul className={TABLE} aria-label="Apps holding a gateway key">
            {data.apps.length + data.agents.length > 0 && (
              <li aria-hidden="true" className={cn(APP_GRID, TABLE_HEAD)}>
                <span>App</span>
                <span className="@max-[38rem]/table:hidden">Credential</span>
                <span className="text-right">Delivered</span>
              </li>
            )}
            {data.apps.length + data.agents.length === 0 ? (
              <li className={TABLE_EMPTY}>No app on this box asked for a gateway key.</li>
            ) : (
              <>
                {data.agents.map((a) => (
                  <li key={a.tab} className={cn(APP_GRID, TABLE_ROW, TABLE_ROW_LINK)}>
                    <div className="min-w-0">
                      <Link
                        to="/c/$category"
                        params={{ category: 'ai' }}
                        search={{ tab: a.tab }}
                        className={cn(TABLE_LINK, CELL_NAME)}
                      >
                        {a.name}
                      </Link>
                      <p className={PHONE_SUB}>{a.credential}</p>
                    </div>
                    <span className={cn(CELL_MONO, '@max-[38rem]/table:hidden')}>
                      {a.credential}
                    </span>
                    <span className={cn(CELL_QUIET, 'text-right')}>minted on the gateway</span>
                  </li>
                ))}
                {data.apps.map((a) => (
                  <li key={a.name} className={cn(APP_GRID, TABLE_ROW, TABLE_ROW_LINK)}>
                    <div className="min-w-0">
                      <Link
                        to="/apps/$name"
                        params={{ name: a.name }}
                        search={{ tab: 'overview' as const }}
                        className={cn(TABLE_LINK, CELL_NAME)}
                      >
                        {a.name}
                      </Link>
                      <p className={PHONE_SUB}>LITELLM_API_KEY</p>
                    </div>
                    {/* The same variable on every row: quiet, so a row that ever
                      differs is the one that shows. */}
                    <span className={cn(CELL_MONO, '@max-[38rem]/table:hidden')}>
                      LITELLM_API_KEY
                    </span>
                    <span className={cn(CELL_QUIET, 'text-right')}>injected at deploy</span>
                  </li>
                ))}
              </>
            )}
          </ul>
        </TableSection>
      </BoardGrid>

      {data.openWebui !== null && (
        <section className={BREAK}>
          <OpenWebUiView data={data.openWebui} />
        </section>
      )}
      {data.n8n !== null && (
        <section className={BREAK}>
          <p className={cn(CAPTION, '-mt-3 mb-5')}>
            n8n — workflows that call a model through the gateway, on the key its own page shows.
          </p>
          <N8nView data={data.n8n} />
        </section>
      )}
    </>
  )
}
