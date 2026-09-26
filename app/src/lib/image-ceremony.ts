// The typed-name gate on a ceremony image update.
//
// `fleet.imageUpdates.<container>.ceremony` names, in one clause, what ELSE an
// update takes down — the blast radius the container's own name does not carry
// (bouncing `pg` reconnects fifteen tenants and kills pocket-id). The box's
// answer is not to forbid the update but to make it deliberate: the operator
// types the container's name before the button arms.
//
// A predicate rather than an inline comparison at each door, because there are
// now two doors — the Updates panel and the MCP `image.update` tool — and a
// gate whose meaning is copied is a gate that eventually differs. Pure, so the
// browser and the server can both hold the same one.

/**
 * Whether an update of `container` may proceed.
 *
 * `null` ceremony is armed unconditionally: most pins take down only
 * themselves and demanding a typed name for those would teach the operator to
 * type names without reading them, which is how a ceremony stops working.
 *
 * The comparison is trimmed but never case-folded: container names are
 * lowercase by construction, and accepting `PG` for `pg` would be accepting a
 * name the person did not actually read off the row.
 */
export function ceremonyArmed(
  container: string,
  ceremony: string | null,
  typed: string | null | undefined,
): boolean {
  if (ceremony === null) return true
  return (typed ?? '').trim() === container
}

/** What a caller is told when it did not type the name. One sentence, both doors. */
export function ceremonyRefusal(container: string, ceremony: string): string {
  return `Updating ${container} ${ceremony}. Pass confirm: "${container}" to proceed.`
}

/** The leading version number of a tag — `34`, `v3.1.0` → `3`, `24-slim` → `24`. Null for a channel. */
function majorOf(tag: string): string | null {
  return /^v?(\d+)/.exec(tag)?.[1] ?? null
}

/**
 * The ceremony a move from `tag` to `toTag` owes: the pin's own, else its
 * `majorCeremony` when the move changes the leading version number. `toTag`
 * absent is a re-pull of the same tag, which is never a new major.
 */
export function ceremonyFor(
  pin: { tag: string; ceremony: string | null; majorCeremony?: string | null },
  toTag: string | null | undefined,
): string | null {
  if (pin.ceremony !== null) return pin.ceremony
  const mc = pin.majorCeremony ?? null
  if (mc === null || toTag == null || toTag === pin.tag) return null
  const from = majorOf(pin.tag)
  const to = majorOf(toTag)
  return from !== null && to !== null && from !== to ? mc : null
}
