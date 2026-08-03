import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

// Everything the LiteLLM gateway is currently serving — chat, embeddings, STT,
// TTS and image models, most of them backed by Lemonade on the gaming PC.
//
// Proof that the gateway wiring works end to end, and the surface any future
// LLM feature in daedalus builds on. The master key never reaches the browser:
// the fetch happens in a server function and only the model list comes back.
const getModels = createServerFn().handler(async () => {
  const { env } = await import('../lib/env')

  const res = await fetch(`${env.litellmBaseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${env.litellmApiKey}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`LiteLLM answered HTTP ${String(res.status)}`)
  }

  const body = (await res.json()) as { data?: { id?: string; owned_by?: string }[] }
  return (body.data ?? [])
    .map((m) => ({ id: m.id ?? 'unknown', ownedBy: m.owned_by ?? '' }))
    .sort((a, b) => a.id.localeCompare(b.id))
})

export const Route = createFileRoute('/models')({
  loader: () => getModels(),
  component: Models,
  errorComponent: ({ error }) => (
    <>
      <h1>Models</h1>
      <section className="card bad">
        <h2>
          <span className="dot" aria-hidden="true" />
          Gateway unreachable
        </h2>
        <p>{error.message}</p>
      </section>
    </>
  ),
})

function Models() {
  const models = Route.useLoaderData()

  return (
    <>
      <h1>Models</h1>
      <p className="lede">
        Served by the LiteLLM gateway at <code>litellm:4000</code>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td>
                <code>{m.id}</code>
              </td>
              <td>{m.ownedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
