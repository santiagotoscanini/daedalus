---
paths:
  - "app/src/components/**"
  - "app/src/routes/**"
  - "app/src/modules/**"
  - "app/src/*.css"
---

# daedalus — the UI layer

Tailwind v4 + shadcn (new-york), on top of tokens a theme preset can
replace at runtime. This file is how to write a component here; the
data flow and architecture map are in `daedalus-app.md`.

## The three stylesheets

- `src/app.css` — the only one the document links. Declares the
  cascade layers and imports the other two. Read its header before
  changing anything about ordering.
- `src/theme.css` — every colour in the app, once. shadcn token names
  in OKLCH, plus `--success`/`--warning`/`--danger`/`--info`, plus the
  app's own five surfaces and inks (`bg-raised`, `bg-lifted`,
  `border-subtle`, `text-subdued`, `*-primary-dim`; its header says which
  is which).
- `src/styles.css` — what is left of the original hand-written CSS,
  imported into the `legacy` layer: element defaults (`body`, `code`,
  `a`, `h1`, `h2`), the `@keyframes` that `animate-[…]` utilities
  name. No class at all. **Nothing new goes in
  it** — a class in there would be the one rule a utility cannot
  override from the caller.

**The layer order is load-bearing**: `theme, base, legacy, components,
utilities`. `legacy` above `base` means Tailwind's preflight cannot
reset the element defaults; `legacy` below `utilities` means a utility
on an element beats them. Both directions matter.

## Writing a component

No component names a class `styles.css` defines (`scripts/dead-css.mjs`
checks). What a component looks like:

1. Utilities through `cn()` (`src/lib/cn.ts`), which lets a caller's
   `className` override the component's own. Repeated class strings
   are module-level `UPPER_CASE` constants; the shared ones live in
   `src/components/tokens.ts` (`MONO`, `FOOT`, `ROW`…), `viz/`
   (`BOARD`, `STAT`…) and a directory's `shared.tsx` (`BOARD_FOOT`,
   `SECTION_HEAD`, `GHOST_BTN`…) — reuse before re-spelling.
2. Reach for a shadcn primitive in `src/components/ui/` before
   hand-rolling: `Card` for a panel, `Chip` (`viz/stats.tsx`) for a pill, `Picker` for
   a closed list (it wraps `Select`; nothing else uses `Select`
   directly), `Field` for a form row, `Alert` (body in
   `AlertDescription`, never bare text — its grid puts bare text in a
   zero-width column). The kit holds only what something renders: a
   primitive nothing uses is deleted, and added back from shadcn
   (new-york) the day a component needs it.
3. **Every button is `Button`** (`ui/button.tsx`), whose variants carry
   the house looks: `default` is the foreground fill (the primary
   action is white on a dark page, not the brand colour), `outline` the
   quiet bordered one, `ghost` muted text, `destructive` outlined in
   the danger colour. A link styled as a button is `<Button asChild>`.
   Never hand-roll a `BTN_*` constant beside it.
4. **Use the shared behaviour, never a local copy**: `useAction`
   (`use-action.ts`) for a button that runs something, `usePoll` /
   `useLiveValue` (`poll.ts`) for a value that moves, `ArmedConfirm` /
   `TypedConfirm` for a confirm step, `Toggle` (`slider.tsx`) for a
   switch, `<Ago>` / `<Until>` / `<When>` (`ago.tsx`) for a time and
   `lib/format.ts` for every number — a time rendered from the clock
   during render is a hydration mismatch.
5. **One component per board, under 400 lines a file**
   (`src/file-size.test.ts` fails a longer one; its allowlist names the
   exceptions and why).
6. **Keep an exported API identical** when restyling. The shared
   components have many call sites; a props change turns a restyle into
   a refactor.
7. A loading skeleton borrows the real component's box constant
   (`BOARD`, `STAT_STRIP`, `APP_LIST`…) rather than approximating it,
   so nothing reflows when data lands.

## The surface ladder (2026-10 restyle)

Linear / Notion, not glow: dark mode is a GREY ladder, never near-black.

- **Canvas** — `--sidebar`: the body and the rail, which sits flush on it
  (no border, no card).
- **Panel** — `--background`: the content column, inset into the canvas
  (`shell.tsx`: rounded, hairline, `my-2 mr-2` on desktop).
- **Surface** — `--surface` (`bg-surface`): a board or card, a veil over
  the panel. Its full look is `GLASS` (`viz/board.tsx`) — a hand-rolled
  bordered panel is a bug; use `Board`, `Card`/`Section` or `GLASS`.
- Edges are `border-hairline`; a lit top edge is
  `shadow-[inset_0_1px_0_var(--hairline-hi)]`. Floating layers (menus, the
  palette, the apply dock) are `bg-popover/80 backdrop-blur-2xl` +
  `--float-shadow`. These are DERIVED in `theme.css` from the themeable
  tokens, so no preset needs them.
- One-of-N controls (tabs, filters, pickers) are the segmented control:
  `SEGMENT_TRACK` / `SEGMENT_ITEM` / `SEGMENT_ITEM_ON` (`tokens.ts`).
- Restraint: colour is for state. No glows, gradients or accent bars as
  ornament. Type: Geist / Geist Mono; page title 1.75rem/640, board title
  0.875rem/560, captions 0.75–0.78rem muted, figures 1.6rem tabular.
- **Explanations fold.** `FOOT` (and settings `NOTE`) carry the marker
  class `explain`; a `Board` or settings `Section` hides every `.explain`
  inside it until its ⓘ is pressed (`components/explain.tsx`, CSS `:has()`
  decides whether the ⓘ is drawn). A caption that carries a live fact or a
  state is `CAPTION`, which never folds.
- Rail groups come from the manifest's `section`.

## Tone is a variable, not a class

Six verdicts (`accent | ok | warn | bad | info | muted`), and every
primitive that carries one tints several parts at once — a fill, a
track, a label. So the root sets one variable and the parts read it:

```tsx
import { type Tone, toneStyle } from '../lib/tone'

<div className="…" style={toneStyle(tone)}>
  <span className="text-(--tone)">{value}</span>
  <i className="bg-(--tone) opacity-70" />
</div>
```

Never write `text-success` / `bg-warning` directly in a primitive that
takes a `tone` prop. A per-tone class would have to be one of six
literal strings for Tailwind's scanner to emit it, which is the
forty-two-rule table `lib/tone.ts` exists to delete. Fixed-meaning
colour on a component that does NOT take a tone is fine as a utility.

## Colour rules

- **Never write a hex, `rgb()` or `oklch()` outside `theme.css`.** If
  a component needs a colour the tokens do not have, the answer is a
  new token, not a literal.
- **Never use Tailwind's built-in palette** (`text-gray-400`,
  `bg-zinc-900`). Those are fixed values that ignore the theme; a
  preset swap would leave them behind. Only token-backed colours
  exist here: `background foreground card popover primary secondary
  muted accent destructive success warning danger info overlay border input
  ring chart-1..5 sidebar* raised lifted subtle subdued primary-dim`.
- Dark is the shipped default but not the only one. Anything that
  assumes a dark background — a white glow, a black shadow, an
  opacity chosen against `#0a0a0a` — is a bug in light mode. Check
  both before calling a file done.

## Icons

`lucide-react` is available, **and must stay in `ssr.noExternal`** in
`vite.config.ts`. It publishes no `exports` map, so left external the
SSR runner loads its CommonJS build while the browser loads the ESM
one: two React instances, and every page importing an icon dies on
hydration with "Invalid hook call" — over server-rendered HTML that
screenshots perfectly.

The app's own inline-SVG sets (`nav-icon.tsx`, `glyph.tsx`) stay.
They are drawn for 17–18px and for the rail's collapsed state, which
a generic icon set does not survive.

## Verifying a restyle

`pnpm typecheck` and `pnpm lint` do not see a single pixel, and there
are no component tests — the suite is node-side tests over `src/lib`,
`src/core`, `src/host` and the modules' data. So the check is a browser
(the shotter command in the root `CLAUDE.md`):

1. `events.json` before the pictures, always: the baseline is zero page
   errors, so any is yours.
2. Compare against a before-shot of the same page. Restyling is
   supposed to change how a page looks, so "it renders" is not the
   bar — the bar is that nothing LOST information: no dropped label,
   no collapsed column, no number that stopped being monospaced.
3. Check one data-heavy page in light mode.
