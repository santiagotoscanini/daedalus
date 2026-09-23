import { FOOT, LIST, ROW, ROW_MAIN, ROW_SIDE, SUB } from '../../../components/tokens'
import { Board, BoardGrid } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { ConsumersData } from '../data/consumers'
import { N8nView } from './n8n'
import { OpenWebUiView } from './open-webui'

// The Consumers tab: what calls the gateway. Open WebUI and n8n keep the
// pages they had, one under the other; the apps that hold a key are a
// list, since each has a page of its own.

export function ConsumersView({ data }: { data: ConsumersData }) {
  return (
    <>
      <BoardGrid>
        <Board
          title="Apps holding a gateway key"
          icon="rows"
          span={12}
          aside={<span className={FOOT}>{num(data.apps.length)} of the box's apps</span>}
        >
          {data.apps.length === 0 ? (
            <p className={FOOT}>No app on this box asked for a gateway key.</p>
          ) : (
            <ul className={LIST}>
              {data.apps.map((a) => (
                <li key={a.name} className={ROW}>
                  <span className={ROW_MAIN}>{a.name}</span>
                  <span className={ROW_SIDE}>LITELLM_API_KEY injected at deploy</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            A key per app, minted by the box and rotated with the app; what each key may call is the
            gateway's policy, and the Gateway tab's callers list is who actually did.
          </p>
        </Board>
      </BoardGrid>

      {data.openWebui !== null && (
        <section>
          <p className={`${SUB} mt-[1.2rem] mb-[0.6rem]`}>Open WebUI — the chat window</p>
          <OpenWebUiView data={data.openWebui} />
        </section>
      )}
      {data.n8n !== null && (
        <section>
          <p className={`${SUB} mt-[1.2rem] mb-[0.6rem]`}>
            n8n — workflows that call a model through the gateway, on the key its own page shows.
          </p>
          <N8nView data={data.n8n} />
        </section>
      )}
    </>
  )
}
