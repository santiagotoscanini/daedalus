import { describe, expect, it } from 'vitest'
import { dhcpHostsDocument, macsOf, targetsDocument } from './node-targets'

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

describe('the dnsmasq lines', () => {
  it('names each machine by its MAC, pinned only when asked, sorted by id', () => {
    expect(
      dhcpHostsDocument([
        { id: 'b', mac: 'aa:bb:cc:dd:ee:02', name: 'macbook-pro', lanIp: null },
        { id: 'a', mac: 'aa:bb:cc:dd:ee:01', name: 'gaming-pc', lanIp: '192.168.0.120' },
      ]),
    ).toBe('aa:bb:cc:dd:ee:01,192.168.0.120,gaming-pc\naa:bb:cc:dd:ee:02,macbook-pro\n')
    expect(dhcpHostsDocument([])).toBe('')
  })
  it('reads the household file’s MACs, whatever case and shape the lines have', () => {
    const macs = macsOf(
      '# home\nAA:BB:CC:DD:EE:01,192.168.0.120,gaming-pc\n\naa:bb:cc:dd:ee:03,printer,infinite\nid:abc,192.168.0.9,thing\n',
    )
    expect([...macs].sort()).toEqual(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:03'])
  })
})
