import { describe, expect, it } from 'vitest'
import { coveredBy, isQueue, type QueueItem, withItem, withoutItem } from './update-queue'

const item = (container: string, over: Partial<QueueItem> = {}): QueueItem => ({
  container,
  toTag: null,
  tag: 'latest',
  lockstep: [],
  ceremony: null,
  typed: '',
  ...over,
})

describe('the update queue', () => {
  it('holds a pin once, the latest choice', () => {
    const q = withItem([item('a', { toTag: '1' })], item('a', { toTag: '2' }))
    expect(q.map((i) => i.toTag)).toEqual(['2'])
  })

  it('drops a pin', () => {
    expect(withoutItem([item('a'), item('b')], 'a').map((i) => i.container)).toEqual(['b'])
  })

  it('knows a lockstep member is already moved by its primary', () => {
    const q = [item('immich', { lockstep: ['immich-machine-learning'] })]
    expect(coveredBy(q, 'immich-machine-learning')).toBe('immich')
    expect(coveredBy(q, 'sonarr')).toBeNull()
  })

  it('reads only a queue it could have written', () => {
    expect(isQueue([item('a')])).toBe(true)
    for (const bad of [null, {}, [{}], [{ ...item('a'), lockstep: [1] }]]) {
      expect(isQueue(bad)).toBe(false)
    }
  })
})
