import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'ai',
  label: 'AI',
  lede: 'The local model server, the gateway in front of it, and what is driving traffic through it.',
  order: 10,
  // Shaped to Lemonade, the tab that opens by default: the model list and
  // the release notes side by side, then the logs across the bottom.
  boardSpans: [6, 6, 12],
  // No tile directory. It held one tile per service, and each of those is
  // now a tab on this page — the same name, dot, description and link, one
  // scroll further down.
  // A tab per service, in the order a prompt travels: the thing that holds
  // the weights, the gateway in front of it, then the two callers. Lemonade
  // leads because it is the one that is off this box and the one whose state
  // (what is resident, is the card full) actually changes hour to hour.
  tabs: [
    // The model server runs on the gaming PC and is in no nix module; what
    // this box declares for it is the log bridge, which is the tab's only
    // container and the one whose absence means the tab has nothing to say.
    { id: 'lemonade', label: 'Lemonade', probe: 'lemonade', nix: 'lemonade-logs' },
    // Traffic + the tool list, then who is calling + the changelog. Paired
    // by height rather than by subject — see the note on that board.
    {
      id: 'litellm',
      label: 'LiteLLM',
      probe: 'litellm',
      boardSpans: [8, 4, 4, 8],
      nix: 'litellm',
    },
    // What it can reach + who gets in, then the changelog across.
    {
      id: 'open-webui',
      label: 'Open WebUI',
      probe: 'open-webui',
      boardSpans: [6, 6, 12],
      nix: 'open-webui',
    },
    // Runs + the workflows behind them, same 8/4 pairing as the gateway.
    { id: 'n8n', label: 'n8n', probe: 'n8n', boardSpans: [8, 4, 12], nix: 'n8n' },
  ],
} as const satisfies ModuleManifest
