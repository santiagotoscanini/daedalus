import { createFileRoute } from '@tanstack/react-router'

// Exactly what the Apply flow would write to stacks/apps/apps.json.
//
// Read-only: Apply (writing the file, committing, rebuilding) is not wired up
// yet. Serving it now is what makes the round-trip checkable — the export of a
// freshly-imported registry must be byte-identical to the file it was imported
// from, or the schema is lossy and Apply would silently change the system.
//
// The `_generated` / `_why` preamble is reattached here rather than stored in
// the database: it is a note to whoever opens the file, not registry data.
export const Route = createFileRoute('/api/registry/export')({
  server: {
    handlers: {
      GET: async () => {
        const { listApps, toRegistryExport } = await import('../lib/repo/apps')
        const { readNixManifest } = await import('../lib/nix-manifest')

        const [records, manifest] = await Promise.all([listApps(), readNixManifest()])
        const body = toRegistryExport(records)

        const preamble = manifest.registry as unknown as Record<string, unknown>

        return new Response(
          `${JSON.stringify(
            {
              _generated: preamble._generated,
              _why: preamble._why,
              ...body,
            },
            null,
            2,
          )}\n`,
          { headers: { 'content-type': 'application/json' } },
        )
      },
    },
  },
})
