// What more than one of the Claude page's files spells the same way: the
// narrow-width hide, the arming window, and the look of the controls at the
// foot of a board.

/* A detail that earns its place on a wide row and not on a narrow one. Every
   side slot truncates, so a row of seven on a phone technically fits — as a
   chip, a clipped name and five ellipses, which is width spent to say nothing.
   Dropping the least important outright gives the rest room to be read. */
export const NARROW_HIDE = 'max-[50rem]:hidden'

/** Same arming window as the box restart (modules/system/view/host.tsx), for
    the same reason: a control left armed by a distraction must not be
    finished by a stray click later. */
export const RC_ARM_MS = 10_000

/* The look of every control at a board's foot here, armed or not — the same
   shape as the box restart on System › Host: quiet at rest, and the cost — and
   the red — appear only once it is armed. */
export const RESTART =
  'mt-[0.7rem] flex flex-col items-start gap-[0.55rem] border-(--border-soft) border-t pt-[0.75rem]'
export const RESTART_ARMED = 'border-t-[color-mix(in_srgb,var(--danger)_40%,var(--border-soft))]'
export const RESTART_COST = 'text-[0.78rem] text-(--text-muted) leading-[1.5]'
export const RESTART_STATE = 'text-[0.78rem] leading-[1.5]'
export const RESTART_NOTE = 'text-[0.7rem] text-muted-foreground leading-[1.5]'
