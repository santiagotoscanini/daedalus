import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

// Overview: does daedalus actually have the three things the NixOS module
// promised it? Nothing here is domain logic — it exists so a broken wiring
// shows up as a red card instead of as a confusing failure three features from
// now.
//
// A server function rather than a plain loader: route loaders also run in the
// browser on client-side navigation, and neither DATABASE_URL nor
// LITELLM_API_KEY may cross that boundary.
const getStatus = createServerFn().handler(async () => {
  const { sql } = await import('../lib/db')
  const { env } = await import('../lib/env')

  const database = await sql`SELECT current_database() AS name, version() AS version`
    .then(([row]) => ({
      ok: true as const,
      detail: `${String(row?.name)} — ${String(row?.version).split(' ').slice(0, 2).join(' ')}`,
    }))
    .catch((err: unknown) => ({ ok: false as const, detail: String(err) }))

  const litellm = await fetch(`${env.litellmBaseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${env.litellmApiKey}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      const body = (await res.json()) as { data?: unknown[] }
      return { ok: true as const, detail: `${String(body.data?.length ?? 0)} models available` }
    })
    .catch((err: unknown) => ({ ok: false as const, detail: String(err) }))

  return { database, litellm, hostname: env.hostname }
})

export const Route = createFileRoute('/')({
  loader: () => getStatus(),
  component: Overview,
})

function Overview() {
  const { database, litellm, hostname } = Route.useLoaderData()

  return (
    <>
      <h1>Control plane</h1>
      <p className="lede">
        Running <code>vite dev</code> against{' '}
        <code>/etc/nixos/stacks/daedalus/app</code> — edit a file on the box and
        this page updates itself.
      </p>

      <div className="cards">
        <StatusCard title="Postgres" {...database} />
        <StatusCard title="LiteLLM" {...litellm} />
        <StatusCard title="Ingress" ok detail={hostname} />
      </div>
    </>
  )
}

function StatusCard({ title, ok, detail }: { title: string; ok: boolean; detail: string }) {
  return (
    <section className={ok ? 'card ok' : 'card bad'}>
      <h2>
        <span className="dot" aria-hidden="true" />
        {title}
      </h2>
      <p>{detail}</p>
    </section>
  )
}
