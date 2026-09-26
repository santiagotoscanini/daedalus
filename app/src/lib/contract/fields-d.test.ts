import { describe, expect, it } from 'vitest'
import { arrayOf, asValidator, obj, withMessage } from './decode'
import { containerNameField, imageTargetField, nodeIdField } from './fields-d'

// Each decoder beside the hand-written check it replaced: same answer, same
// refusal sentence, for inputs on both sides of the line.

const refusal = (f: () => unknown): string | null => {
  try {
    f()
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('nodeIdField', () => {
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
