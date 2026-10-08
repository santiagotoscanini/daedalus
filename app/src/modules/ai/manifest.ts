import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'ai',
  label: 'AI',
  lede: 'The machines that provide models, the gateway that publishes them, and what calls it.',
  order: 10,
  section: 'Services',
  // Shaped to Providers, the tab that opens by default: the chain across
  // the top, then the picked machine's Lemonade, its GPU and its model table.
  boardSpans: [12, 12, 12, 12],
  // Tabs in the order a prompt travels backwards: where the weights
  // are, the gateway in front of them, the callers. Providers has no
  // ServiceHead — its subject is several machines, drawn from
  // its own picker; the other two are services on this box.
  tabs: [
    {
      id: 'providers',
      label: 'Providers',
      // The published model server's probe — every tab in this row wears a
      // dot or none does, and the rail rolls them up.
      probe: 'lemonade',
      boardSpans: [12, 12, 12, 12],
      head: false,
    },
    {
      id: 'gateway',
      label: 'Gateway',
      probe: 'litellm',
      boardSpans: [12, 12, 12, 12],
      nix: 'litellm',
    },
    // Shown while any caller on this box is; the apps that hold a key
    // are listed regardless.
    {
      id: 'consumers',
      label: 'Consumers',
      // The chat window: the one consumer on this box with a probe.
      probe: 'open-webui',
      boardSpans: [12, 12, 12],
      head: false,
      nix: ['open-webui', 'n8n', 'hermes-agent'],
    },
    // An agent that lives on this box and calls the gateway on its own key:
    // a service of its own, so it opens with a ServiceHead like the gateway does.
    {
      id: 'hermes-agent',
      label: 'Hermes Agent',
      probe: 'hermes-agent',
      boardSpans: [12, 12, 12, 12],
      nix: 'hermes-agent',
    },
  ],
  // The four tabs this row replaced, for the links that named them.
  aliases: {
    lemonade: 'providers',
    litellm: 'gateway',
    'open-webui': 'consumers',
    n8n: 'consumers',
  },
} as const satisfies ModuleManifest
