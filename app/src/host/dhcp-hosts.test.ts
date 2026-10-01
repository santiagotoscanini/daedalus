import { describe, expect, it } from 'vitest'
import { dhcpHostsDocument, macsOf } from './dhcp-hosts'

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

describe('writing the file', () => {
  it('never rewrites an unchanged file: each write reloads pi-hole', async () => {
    const { mkdtemp, readFile, stat, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeDhcpHosts } = await import('./dhcp-hosts')
    const dir = await mkdtemp(join(tmpdir(), 'dhcp-hosts-'))
    try {
      const one = [{ id: 'a', mac: 'aa:bb:cc:dd:ee:01', name: 'gaming-pc', lanIp: null }]
      expect(await writeDhcpHosts(one, dir)).toBe(true)
      const first = await stat(join(dir, 'dhcp-hosts'))
      // The same lines again — a switch saved, a name that did not move.
      expect(await writeDhcpHosts([...one], dir)).toBe(false)
      const again = await stat(join(dir, 'dhcp-hosts'))
      expect(again.ino).toBe(first.ino)
      expect(again.mtimeMs).toBe(first.mtimeMs)
      // A line that moved is written.
      expect(await writeDhcpHosts([{ ...one[0], name: 'renamed' } as (typeof one)[0]], dir)).toBe(
        true,
      )
      expect(await readFile(join(dir, 'dhcp-hosts'), 'utf8')).toBe('aa:bb:cc:dd:ee:01,renamed\n')
      // An empty set over an empty file is no write either.
      expect(await writeDhcpHosts([], dir)).toBe(true)
      expect(await writeDhcpHosts([], dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
