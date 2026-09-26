import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Join class names, letting the LAST conflicting Tailwind utility win.
 *
 * `clsx` alone would emit `px-2 px-4` and leave the winner to whichever
 * rule the stylesheet happens to define later — which for two utilities in
 * the same layer is arbitrary. `twMerge` understands the utility grammar
 * and drops the loser, so a component can take `className` from a caller
 * and have that override its own defaults. Every shadcn primitive is
 * written against that guarantee.
 *
 * It only knows about Tailwind utilities; any other class name passes
 * through untouched.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
