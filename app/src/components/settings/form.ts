// Two pieces of the settings form vocabulary that shared.tsx does not carry.
//
// shared.tsx's NOTE carries the `explain` marker, so inside a Section it is
// folded behind the card's ⓘ. That is right for prose that explains, and wrong
// for a sentence the operator needs to act or to know the state: a result
// ("Saved."), a failure, a warning, the one instruction a form needs. Those
// wear NOTE_SHOWN: the same face as NOTE, never folded.
//
// And one height for every control that sits in a settings row. `Input` and
// the `Picker` trigger each bring their own (a padded auto height and a fixed
// 36px), so a picker in one row stood a few pixels taller than the text box in
// the next. CONTROL_H pins both — the `data-[size=default]` half is the
// trigger's own size rule, which a bare `h-8` does not outrank.

/** NOTE's look without the `explain` marker: a state or an instruction, always visible. */
export const NOTE_SHOWN = 'm-0 max-w-[72ch] text-[0.8rem] leading-relaxed text-subdued'

/** The one height of a field in a settings row: Input, Picker trigger and the button beside them. */
export const CONTROL_H = 'h-8 py-0 data-[size=default]:h-8'

/**
 * The inner tile a disclosed form, an armed confirm or a sub-list sits in
 * inside a settings card: 12px, a hairline, the faintest fill — one radius
 * step inside the card's 16px, so it reads as part of the card and not as a
 * second card laid on it.
 */
export const INSET =
  'flex flex-col gap-3 rounded-xl border border-hairline bg-foreground/[0.02] p-4'
