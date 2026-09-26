import { describe, expect, it } from 'vitest'
import { arrayOf, asValidator, DecodeError, decode, obj, withMessage } from './decode'
import {
  containerNameField,
  flagField,
  imageTargetField,
  nodeIdField,
  nonBlankField,
  nonEmptyStringField,
  pageSizeField,
  recordField,
  secretKeyField,
  stringMapField,
  strMax,
  taskIdField,
} from './fields'

// Each decoder beside the hand-written check it replaced where there was one:
// same answer, same refusal sentence, for inputs on both sides of the line.

const refusal = (f: () => unknown): string | null => {
  try {
    f()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('shapes, task ids, secret keys and maps', () => {
  it('recordField passes a plain object on as it is, and refuses arrays and null', () => {
    const o = { a: 1 }
    expect(decode(recordField, o)).toBe(o)
    expect(() => decode(recordField, [])).toThrow()
    expect(() => decode(recordField, null)).toThrow()
  })

  it('nonEmptyStringField refuses the empty string', () => {
    expect(decode(nonEmptyStringField, 'x')).toBe('x')
    expect(() => decode(nonEmptyStringField, '')).toThrow()
    expect(() => decode(nonEmptyStringField, 1)).toThrow()
  })

  it('taskIdField refuses with taskId’s sentence', () => {
    expect(decode(taskIdField, 'nightly-sync')).toBe('nightly-sync')
    expect(() => decode(taskIdField, 'Bad Id')).toThrow(/^expected a task id$/)
  })

  it('secretKeyField refuses with secret-keys’ own sentence, through an outer withMessage', () => {
    const d = withMessage(obj({ key: secretKeyField }), 'outer')
    expect(decode(d, { key: 'API_KEY' })).toEqual({ key: 'API_KEY' })
    expect(() => decode(d, {})).toThrow(/^no variable name was given$/)
    expect(() => decode(d, null)).toThrow(/^outer$/)
  })

  it('stringMapField names the key whose value is not a string', () => {
    expect(decode(stringMapField, { a: 'b' })).toEqual({ a: 'b' })
    expect(() => decode(stringMapField, { a: 'b', n: 1 })).toThrow(/^n must be a string$/)
    expect(() => decode(stringMapField, [])).toThrow()
  })

  it('pageSizeField clamps a whole number and falls back on anything else', () => {
    const d = pageSizeField(50, 10)
    expect([0, 1, 7, 51, -3].map((v) => decode(d, v))).toEqual([1, 1, 7, 50, 1])
    expect([undefined, null, '5', 2.5, Number.NaN].map((v) => decode(d, v))).toEqual([
      10, 10, 10, 10, 10,
    ])
  })
})

describe('strMax', () => {
  it('takes a string up to the cap, the cap included', () => {
    expect(decode(strMax(3), '')).toBe('')
    expect(decode(strMax(3), 'abc')).toBe('abc')
  })

  it('refuses a longer string and a non-string with a DecodeError', () => {
    expect(() => decode(strMax(3), 'abcd')).toThrow(DecodeError)
    expect(() => decode(strMax(3), 3)).toThrow(DecodeError)
    expect(() => decode(strMax(3), null)).toThrow(DecodeError)
  })
})

describe('nodeIdField', () => {
  it('takes 16 lowercase hex digits, and nothing else, with the old sentence', () => {
    expect(nodeIdField('0123456789abcdef', 'id')).toBe('0123456789abcdef')
    for (const bad of ['0123456789ABCDEF', '0123456789abcde', '', 7, null, undefined]) {
      expect(() => nodeIdField(bad, 'id')).toThrow(/^expected a node id$/)
    }
  })
})

describe('flagField', () => {
  it('is on for exactly true', () => {
    expect(flagField(true, 'f')).toBe(true)
    for (const off of [false, 'true', 1, undefined, null]) expect(flagField(off, 'f')).toBe(false)
  })
})

describe('nonBlankField', () => {
  it('keeps the string untrimmed and refuses blanks with its own sentence', () => {
    const f = nonBlankField('expected a model')
    expect(f(' m ', 'm')).toBe(' m ')
    for (const bad of ['', '  ', 3, null, undefined]) {
      expect(() => f(bad, 'm')).toThrow(/^expected a model$/)
    }
  })
})

describe('nodeIdField against the hand-written check', () => {
  const NODE_ID = /^[0-9a-f]{16}$/
  const handWritten = (data: unknown): { id: string } => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error('expected a node id')
    return { id }
  }
  const decoded = asValidator(withMessage(obj({ id: nodeIdField }), 'expected a node id'))

  it.each([
    { id: '0123456789abcdef' },
    { id: '0123456789ABCDEF' },
    { id: '0123456789abcde' },
    { id: 42 },
    {},
    null,
    undefined,
    'x',
    [],
  ])('%j', (input) => {
    expect(refusal(() => decoded(input))).toBe(refusal(() => handWritten(input)))
    if (refusal(() => handWritten(input)) === null)
      expect(decoded(input)).toEqual(handWritten(input))
  })
})

describe('image targets', () => {
  const containerName = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v === '') throw new Error(`${what} must be a container name`)
    return v
  }
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  const handWritten = (data: unknown) => {
    if (!isRecord(data) || !Array.isArray(data.targets)) {
      throw new Error('expected a list of targets')
    }
    return {
      targets: data.targets.map((t: unknown) => {
        if (!isRecord(t)) throw new Error('each target must name a container')
        const container = containerName(t.container, 'each target')
        if (t.toTag === undefined) return { container }
        if (typeof t.toTag !== 'string') throw new Error('toTag must be a string when present')
        return { container, toTag: t.toTag }
      }),
    }
  }
  const decoded = asValidator(
    withMessage(obj({ targets: arrayOf(imageTargetField) }), 'expected a list of targets'),
  )

  it.each([
    { targets: [] },
    { targets: [{ container: 'jellyfin' }] },
    { targets: [{ container: 'jellyfin', toTag: '10.11' }, { container: 'sonarr' }] },
    { targets: [{ container: 'jellyfin', toTag: undefined }] },
    { targets: [{ container: 'jellyfin', toTag: null }] },
    { targets: [{ container: 'jellyfin', toTag: 3 }] },
    { targets: [{ container: '' }] },
    { targets: [{ toTag: 'x' }] },
    { targets: ['jellyfin'] },
    { targets: [null] },
    { targets: 'jellyfin' },
    {},
    null,
    [],
  ])('%j', (input) => {
    expect(refusal(() => decoded(input))).toBe(refusal(() => handWritten(input)))
    if (refusal(() => handWritten(input)) === null) {
      // toStrictEqual: an absent toTag must stay absent, not become a key.
      expect(decoded(input)).toStrictEqual(handWritten(input))
    }
  })

  it('names the field in a container-name refusal', () => {
    const notes = asValidator(
      withMessage(obj({ container: containerNameField('container') }), 'expected a container'),
    )
    expect(notes({ container: 'grafana' })).toEqual({ container: 'grafana' })
    expect(refusal(() => notes({ container: '' }))).toBe('container must be a container name')
    expect(refusal(() => notes(null))).toBe('expected a container')
  })
})
