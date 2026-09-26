import { DecodeError, type Decoder } from './decode'

// Field decoders for the server functions behind Settings, Site, Profile and
// the local login (src/server/**). Pure; only ever named inside a
// `.validator(...)`, which the Start compiler erases from the browser's copy.

/**
 * A string of at most `max` characters — the `typeof v === 'string' &&
 * v.length <= max` check those validators each wrote. Refuses with a
 * DecodeError, so a `withMessage` around it supplies the sentence the page
 * shows (the messages name the field, never its value).
 */
export function strMax(max: number): Decoder<string> {
  return (v, p) => {
    if (typeof v !== 'string') throw new DecodeError(p, 'expected a string')
    if (v.length > max) throw new DecodeError(p, `expected at most ${String(max)} characters`)
    return v
  }
}
