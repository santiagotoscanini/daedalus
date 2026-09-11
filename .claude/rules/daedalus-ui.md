---
paths:
  - "app/src/components/**"
  - "app/src/routes/**"
  - "app/src/*.css"
---

# daedalus — the UI layer

Tailwind v4 + shadcn (new-york), on top of tokens a theme preset can
replace at runtime. This file is how to write a component here; the
dev loop, data flow and architecture map are in `daedalus-app.md`.

## The three stylesheets

- `src/app.css` — the only one the document links. Declares the
  cascade layers and imports the other two. Read its header before
  changing anything about ordering.
- `src/theme.css` — every colour in the app, once. shadcn token names
  in OKLCH, plus `--success`/`--warning`/`--danger`/`--info`, plus the
  legacy `--bg`/`--text`/`--brand` names aliased onto them.
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

The migration from hand-written CSS finished on 2026-09-08: no
component names a class `styles.css` defines (`scripts/dead-css.mjs`
checks). What the converted code looks like, and what a new one must:

1. Utilities through `cn()` (`src/lib/cn.ts`), which lets a caller's
   `className` override the component's own. Repeated class strings
   are module-level `UPPER_CASE` constants; the shared ones live in
   the directory's `shared.tsx` (`BOARD_FOOT`, `SECTION_HEAD`, `MONO`,
   `GHOST_BTN`…) — reuse before re-spelling.
2. Reach for a shadcn primitive in `src/components/ui/` before
   hand-rolling: `Card` for a panel, `Badge` for a pill, `Select` for
   a closed list, `Field` for a form row, `Alert` (body in
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
4. **Keep an exported API identical** when restyling. These components
   have ~65 call sites; a props change turns a restyle into a refactor.
5. A loading skeleton borrows the real component's box constant
   (`BOARD`, `STAT_BAND`, `APP_LIST`…) rather than approximating it,
   so nothing reflows when data lands.

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
  new token, not a literal. This was already violated eleven times by
  one blue that is now `--info`.
- **Never use Tailwind's built-in palette** (`text-gray-400`,
  `bg-zinc-900`). Those are fixed values that ignore the theme; a
  preset swap would leave them behind. Only token-backed colours
  exist here: `background foreground card popover primary secondary
  muted accent destructive success warning danger info overlay border input
  ring chart-1..5 sidebar*`.
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
are no component tests — the suite is node-side table tests over
`src/lib`. So the check is a browser:

1. `events.json` before the pictures, always. Baseline under the gate
   is **2 page errors per load** (the HMR websocket 302s, plus a
   known `Date.now()` hydration mismatch). Anything above that is
   yours.
2. Compare against a before-shot of the same page. Restyling is
   supposed to change how a page looks, so "it renders" is not the
   bar — the bar is that nothing LOST information: no dropped label,
   no collapsed column, no number that stopped being monospaced.
3. Check one data-heavy page in light mode.
