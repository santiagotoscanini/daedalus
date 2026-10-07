import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'health',
  label: 'Health',
  lede: 'One person’s record, and the services that feed what they eat and how they train.',
  order: 35,
  section: 'Services',
  // Shaped to Record, which opens by default.
  boardSpans: [12, 4, 4, 4],
  // A tab per subject, in the order a body is read: the record that holds
  // everything measured, then the three inputs to it — food in the house,
  // food eaten, training done.
  //
  // The rule divides a service you open from a tool server a model calls.
  // Record and Pantry are applications with their own pages; Nutrition and
  // Training are MCP servers that exist only behind the gateway, with no UI
  // to open, so their tabs are a version and a log.
  tabs: [
    {
      id: 'record',
      label: 'Record',
      // Every piece gatus can probe: the app, the relay, the knowledge base
      // and its library manager (the context gateway and the MCP server have
      // no webApp of their own).
      probes: ['getbased', 'getbased-relay', 'getbased-rag', 'getbased-library'],
      boardSpans: [12, 4, 4, 4],
      nix: 'getbased',
    },
    // Grocy and the MCP server that puts it on the gateway: one subject, so
    // one tab, shown while either half is.
    {
      id: 'pantry',
      label: 'Pantry',
      probe: 'grocy',
      boardSpans: [8, 4, 12, 12],
      nix: ['grocy', 'grocy-mcp'],
    },
    {
      id: 'nutrition',
      label: 'Nutrition',
      boardSpans: [12, 12],
      dividerBefore: true,
      nix: 'yazio-mcp',
    },
    { id: 'training', label: 'Training', boardSpans: [12, 12], nix: 'hevy-mcp' },
  ],
} as const satisfies ModuleManifest
