import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'home',
  label: 'Home',
  lede: 'What the house shares, and what one person keeps here.',
  order: 30,
  // Shaped to the House tab, which opens by default.
  boardSpans: [8, 4, 4, 8],
  // No tile directory. It held eight tiles, and the two biggest data stores
  // on this box got four numbers and a link each — no version, no verdict on
  // whether that version is current, and no log. Every one of them is a tab
  // now, carrying the same name, dot and link.
  // The rule divides WHOSE data it is. To its left, what the whole house
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
    // Pocket ID, which had a category of its own until now — see the note in
    // ./view/idp.tsx for why it stopped deserving one.
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
