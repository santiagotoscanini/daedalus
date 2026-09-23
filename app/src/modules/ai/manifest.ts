import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'ai',
  label: 'AI',
  lede: 'The machines that provide models, the gateway that publishes them, and what calls it.',
  order: 10,
  // Shaped to Providers, the tab that opens by default: the chain across
  // the top, then the picked machine's head, its loaded models and catalog.
  boardSpans: [12, 8, 4, 12],
  // Three tabs in the order a prompt travels backwards: where the weights
  // are, the gateway in front of them, the callers. Providers has no
  // ServiceHead and no dot — its subject is several machines, drawn from
  // its own picker; the other two are services on this box.
  tabs: [
    { id: 'providers', label: 'Providers', boardSpans: [12, 8, 4, 12], head: false },
    {
      id: 'gateway',
      label: 'Gateway',
      probe: 'litellm',
      boardSpans: [8, 4, 4, 8],
      nix: 'litellm',
    },
    // Shown while either caller on this box is; the apps that hold a key
    // are listed regardless.
    {
      id: 'consumers',
      label: 'Consumers',
      boardSpans: [6, 6, 12],
      head: false,
      nix: ['open-webui', 'n8n'],
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
