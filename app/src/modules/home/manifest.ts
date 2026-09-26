import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'home',
  label: 'Home',
  lede: 'What the house shares, and what one person keeps here.',
  order: 30,
  // Shaped to the House tab, which opens by default.
  boardSpans: [8, 4, 4, 8],
  // A tab per service, not a tile directory: a tile had no room for the
  // version, the verdict on it, or the log.
  //
  // The rule (`dividerBefore`) divides WHOSE data it is. To its left, what the whole house
  // shares: the automation, the photo library, the file sync, the pantry,
  // and the directory of who can open any of them. To its right, what one
  // person keeps here. It is the only axis on which Wealthfolio and
  // Nextcloud differ — every other reading of "home" puts them together.
  //
  // Sign-in sits last on the shared side rather than first: it is the
  // household's list of people, but it is the answer to a question you ask
  // about the others, not one you open the category to see.
  tabs: [
    {
      id: 'house',
      label: 'House',
      probe: 'home-assistant',
      boardSpans: [8, 4, 4, 8],
      nix: 'home-assistant',
    },
    { id: 'photos', label: 'Photos', probe: 'immich', boardSpans: [8, 4, 4, 8], nix: 'immich' },
    {
      id: 'files',
      label: 'Files',
      probe: 'nextcloud',
      boardSpans: [8, 4, 4, 4],
      nix: 'nextcloud',
    },
    { id: 'pantry', label: 'Pantry', probe: 'grocy', boardSpans: [8, 4, 12], nix: 'grocy' },
    // Pocket ID — ./view/idp.tsx says why it is a Home tab.
    {
      id: 'signin',
      label: 'Sign-in',
      probe: 'pocket-id',
      boardSpans: [6, 6, 3, 9],
      nix: 'pocket-id',
    },
    // Past the rule: one person's, not the household's.
    {
      id: 'finance',
      label: 'Finance',
      probe: 'wealthfolio',
      boardSpans: [12, 12, 12],
      dividerBefore: true,
      nix: 'wealthfolio',
    },
    {
      id: 'tools',
      label: 'Tools',
      probe: 'stirling-pdf',
      boardSpans: [12, 12, 12],
      nix: 'stirling-pdf',
    },
  ],
} as const satisfies ModuleManifest
