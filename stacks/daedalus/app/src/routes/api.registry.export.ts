import { createFileRoute } from '@tanstack/react-router'

// Exactly the bytes Apply would write to stacks/apps/apps.json.
//
// Same renderer the Apply path uses, so this is a preview and not an
// approximation. It is what makes the round-trip checkable: the export of a
// freshly-imported registry must be byte-identical to the file it was
// imported from, or the schema is lossy and Apply would silently change the
// system.
export const Route = createFileRoute('/api/registry/export')({
  server: {
    handlers: {
      GET: async () => {
        const { listApps, toRegistryExport } = await import('../lib/repo/apps')
        const { renderRegistryFile } = await import('../lib/registry-file')

        const body = renderRegistryFile(toRegistryExport(await listApps()))
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      },
    },
  },
})
