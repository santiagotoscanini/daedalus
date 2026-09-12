// A hand-rolled decoder, because the alternative was a validation library.
//
// Every fact this app renders arrives as JSON from outside its type system —
// nix exports, host snapshots, service APIs — and for years each read site
// cast with `as T`, which is a promise the file never made. These combinators
// are the runtime half of those types: ~120 lines, zero dependencies, throwing
// DecodeError with the path that failed so a malformed snapshot names its own
// problem instead of surfacing as `undefined is not a function` three renders
// later.
//
// Deliberately small. The shapes here are flat records and arrays; anything
// zod adds beyond this (transforms, refinements, unions-of-objects) is shape
// complexity the contract itself should not have.

export class DecodeError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path === '' ? '$' : path}: ${message}`)
    this.path = path
  }
}

export type Decoder<T> = (value: unknown, path: string) => T

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

export const str: Decoder<string> = (v, p) => {
  if (typeof v !== 'string') throw new DecodeError(p, `expected a string, got ${kind(v)}`)
  return v
}

export const num: Decoder<number> = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DecodeError(p, `expected a finite number, got ${kind(v)}`)
  }
  return v
}

/**
 * A whole number JS can still tell apart from its neighbours.
 *
 * `num` would take GitHub's `9007199254740993` and answer `…992` — a
 * different account, silently — because past 2^53 the nearest double is a
 * different integer. Anything used as an identity (an id, a count that is
 * compared) decodes with this, not with `num`.
 */
export const int: Decoder<number> = (v, p) => {
  if (typeof v !== 'number') throw new DecodeError(p, `expected a whole number, got ${kind(v)}`)
  if (!Number.isSafeInteger(v)) {
    throw new DecodeError(p, `expected a whole number below 2^53, got ${String(v)}`)
  }
  // -0 is a valid JSON number and an id nobody means: it fails `Object.is`
  // against the 0 it round-trips back as, so it is normalised here.
  return v === 0 ? 0 : v
}

export const bool: Decoder<boolean> = (v, p) => {
  if (typeof v !== 'boolean') throw new DecodeError(p, `expected a boolean, got ${kind(v)}`)
  return v
}

export function literal<const L extends readonly string[]>(...allowed: L): Decoder<L[number]> {
  return (v, p) => {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new DecodeError(p, `expected one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`)
    }
    return v as L[number]
  }
}

export function nullable<T>(d: Decoder<T>): Decoder<T | null> {
  return (v, p) => (v === null ? null : d(v, p))
}

/** Absent or undefined decodes to the fallback — the tolerant-reader knob. */
export function optional<T>(d: Decoder<T>, fallback: T): Decoder<T> {
  return (v, p) => (v === undefined ? fallback : d(v, p))
}

export function arrayOf<T>(d: Decoder<T>): Decoder<T[]> {
  return (v, p) => {
    if (!Array.isArray(v)) throw new DecodeError(p, `expected an array, got ${kind(v)}`)
    return v.map((item, i) => d(item, `${p}[${String(i)}]`))
  }
}

export function recordOf<T>(d: Decoder<T>): Decoder<Record<string, T>> {
  return (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new DecodeError(p, `expected an object, got ${kind(v)}`)
    }
    // Null prototype, for both halves of the same hole. Writing: `out.__proto__
    // = x` on a `{}` hits Object.prototype's setter, so the entry is dropped
    // and the result inherits whatever the attacker sent. Reading: a key the
    // input never carried — `toString`, `constructor` — answers a function
    // where the type says T. Neither is reachable without a prototype.
    const out = Object.create(null) as Record<string, T>
    for (const [k, item] of Object.entries(v)) out[k] = d(item, `${p}.${k}`)
    return out
  }
}

/**
 * An object with a known shape. Unknown keys are ignored — a producer adding
 * a field must never break an older reader — and `optional(...)` fields
 * tolerate the reverse.
 */
export function obj<S extends Record<string, Decoder<unknown>>>(
  shape: S,
): Decoder<{ [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }> {
  return (v, p) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new DecodeError(p, `expected an object, got ${kind(v)}`)
    }
    const source = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(shape)) {
      // Own keys only: a shape key named `toString` or `constructor` would
      // otherwise decode Object.prototype's member instead of the absence the
      // input actually carries.
      const raw = Object.hasOwn(source, k) ? source[k] : undefined
      out[k] = d(raw, p === '' ? k : `${p}.${k}`)
    }
    return out as { [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }
  }
}

/** Runs a decoder over a whole document; the DecodeError carries the path. */
export function decode<T>(d: Decoder<T>, value: unknown): T {
  return d(value, '')
}
