import type { Tone } from './tone'

/** A dot on one rail row (components/shell/rail.tsx `ModuleRow`): a verdict and the sentence behind it. */
export type RailBadge = { tone: Tone; label: string }

/** By module id; a row with none draws no dot. */
export type RailBadges = Partial<Record<string, RailBadge>>
