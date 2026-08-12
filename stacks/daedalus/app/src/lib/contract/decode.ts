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
    const out: Record<string, T> = {}
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
    for (const [k, d] of Object.entries(shape)) out[k] = d(source[k], p === '' ? k : `${p}.${k}`)
    return out as { [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }
  }
}

/** Runs a decoder over a whole document; the DecodeError carries the path. */
export function decode<T>(d: Decoder<T>, value: unknown): T {
  return d(value, '')
}
