import { describe, expect, it } from 'vitest'
import { targetsDocument } from './node-targets'

describe('targetsDocument', () => {
  it('is file_sd: one entry per node with the labels the pages and the agent share', () => {
    const doc = JSON.parse(
      targetsDocument([
        {
          id: 'a2272f1b0bdac468',
          hostname: 'SANTI-PC',
          name: 'Windows PC',
          os: 'windows',
          lanIp: '192.168.0.120',
          statusPort: 7787,
        },
      ]),
    ) as { targets: string[]; labels: Record<string, string> }[]
    expect(doc).toHaveLength(1)
    expect(doc[0]?.targets).toEqual(['192.168.0.120:7787'])
    expect(doc[0]?.labels).toEqual({
      node: 'a2272f1b0bdac468',
      host: 'SANTI-PC',
      machine: 'Windows PC',
      os: 'windows',
    })
  })

  it('is an empty list with no nodes, which prometheus takes as no targets', () => {
    expect(JSON.parse(targetsDocument([]))).toEqual([])
  })
})
