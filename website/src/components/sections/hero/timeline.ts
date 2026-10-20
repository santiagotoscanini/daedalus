/** The hero's sequence, in ms (spec §6.1). Most of it is CSS keyframes (hero.css) whose delays are
 * these same numbers, written next to each element; what is here is the part script runs: when the
 * chat starts, the thread following each arrival, when Grandma's phone takes over, the end of the
 * sequence and the composer's one pass through the examples.
 *
 * It runs in two acts. Your phone's chat starts once its top (the header, your request and room for
 * a reply) is on screen. Grandma's phone starts at the hand-over, or later, once the top of her
 * screen (the notification and Pinch's slot) is on screen under the nav: until then your phone
 * rests on its last row. Each act is timed from its own start: the chat's rows by their `at`
 * (chat-screen.tsx), Grandma's beats from E, which follows `data-b` on the hero.
 *
 * Below 768 the phones share one spot and nobody waits beside the first: the chat runs at TEMPO of
 * its pace and Grandma's phone takes the spot soon after Pinch has arrived. hero.css sets the same
 * TEMPO and E_DELAY at the same breakpoint (--tempo, --e). */

export const NARROW = "(max-width: 767px)";

/** The chat's pace: 1 beside Grandma's phone, faster where the two share one spot. */
export const TEMPO_WIDE = 1;
export const TEMPO_NARROW = 0.65;

/** The hand-over, in ms from the chat's start: Grandma's phone comes in beside yours (768 and up),
 * or takes the spot (below 768, once Pinch's card has been on screen for a third of a second: at
 * that tempo the chat is over by 4.3s, and the second phone is up before a reader moves on). */
export const HANDOVER_WIDE = 6700;
export const HANDOVER_NARROW = 4600;

/** From the hand-over to Phone B's entrance, E: a beat for the chat's column to settle first (768
 * and up, where your phone stays on its spot and hers fades in beside it), or the swap itself (below
 * 768). */
export const E_DELAY_WIDE = 200;
export const E_DELAY_NARROW = 0;

/** After E: the app has opened and every animation has ended. */
export const DONE_AFTER_E = 4400;

/** After E: the composer starts its pass, one example every STEP, back to "Message Home" after four. */
export const COMPOSER_AFTER_E = 4900;
export const COMPOSER_STEP = 3500;

/** The thread column, while it plays: top-anchored this far down the screen, under the header. */
export const THREAD_TOP = 110;
/** Its padding below the last row, and its distance from the thread's bottom edge when it rests. */
export const THREAD_PAD = 6;
/** When the viewport cuts your phone short, the newest row stops this far (CSS px) above its edge. */
export const EDGE_CLEAR = 24;
/** The newest row's bottom never sits higher than this (screen px): below it the reader sees too
 * little of the phone to read the thread, and a row that high would slide under the header. */
export const FLOOR_MIN = 270;
