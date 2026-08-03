import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

const getRuntime = createServerFn().handler(async () => {
  const { env } = await import('../lib/env')
  return {
    app: env.appName,
    hostname: env.hostname,
    publicUrl: env.publicUrl,
    node: process.version,
    // Deliberately not the values — just whether the module handed them over.
    // A missing secret should be diagnosable without printing it.
    wiring: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      LITELLM_BASE_URL: Boolean(process.env.LITELLM_BASE_URL),
      LITELLM_API_KEY: Boolean(process.env.LITELLM_API_KEY),
      AUTH_SECRET: Boolean(process.env.AUTH_SECRET),
    },
  }
})

export const Route = createFileRoute('/about')({
  loader: () => getRuntime(),
  component: About,
})

function About() {
  const rt = Route.useLoaderData()

  return (
    <>
      <h1>About</h1>
      <p className="lede">
        daedalus is declared in <code>stacks/daedalus/daedalus.nix</code> and its
        source lives beside it at <code>stacks/daedalus/app/</code>, inside the
        flake repo. It is the one app on the box that is not built by CI: the
        container bind-mounts that directory and runs the Vite dev server, so a
        saved file is the whole deploy.
      </p>

      <table>
        <tbody>
          <tr>
            <th>App</th>
            <td>
              <code>{rt.app}</code>
            </td>
          </tr>
          <tr>
            <th>Hostname</th>
            <td>
              <code>{rt.hostname}</code>
            </td>
          </tr>
          <tr>
            <th>Public URL</th>
            <td>
              <code>{rt.publicUrl}</code>
            </td>
          </tr>
          <tr>
            <th>Node</th>
            <td>
              <code>{rt.node}</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Injected environment</h2>
      <table>
        <tbody>
          {Object.entries(rt.wiring).map(([key, present]) => (
            <tr key={key}>
              <th>
                <code>{key}</code>
              </th>
              <td>{present ? 'present' : 'MISSING'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
