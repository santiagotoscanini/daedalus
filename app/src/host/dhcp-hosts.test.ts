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

describe('handing the lines over', () => {
  it('never starts a run for the lines the host keeps: each run reloads pi-hole', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeDhcpHosts, dhcpHostsMissing } = await import('./dhcp-hosts')
    const dir = await mkdtemp(join(tmpdir(), 'dhcp-hosts-'))
    const previous = process.env.VERBS_DIR
    process.env.VERBS_DIR = dir
    const asked: unknown[][] = []
    let outcome = 'done'
    const ctx = {
      controller: {
        call: async (
          _: string,
          p: { verb: string; selectors: object; payload?: string },
          o: { waitMs: number },
        ) => {
          asked.push([p.verb, p.selectors, o.waitMs, p.payload])
          return { run: 'r', verb: 'nodes-dhcp', outcome, detail: 'a line is not', verbs: [] }
        },
      },
    } as unknown as Parameters<typeof writeDhcpHosts>[0]
    try {
      const one = [{ id: 'a', mac: 'aa:bb:cc:dd:ee:01', name: 'gaming-pc', lanIp: null }]
      expect(await dhcpHostsMissing()).toBe(true)
      expect(await writeDhcpHosts(ctx, one)).toBe(true)
      expect(asked[0]?.slice(0, 2)).toEqual(['nodes-dhcp', {}])
      expect(asked[0]?.[3]).toBe('aa:bb:cc:dd:ee:01,gaming-pc\n')
      // The host kept them: the same lines again start nothing.
      await writeFile(join(dir, 'nodes-dhcp-hosts'), 'aa:bb:cc:dd:ee:01,gaming-pc\n')
      expect(await dhcpHostsMissing()).toBe(false)
      expect(await writeDhcpHosts(ctx, [...one])).toBe(false)
      expect(asked).toHaveLength(1)
      // A refusal is the caller's to log.
      outcome = 'refused'
      await expect(writeDhcpHosts(ctx, [])).rejects.toThrow('a line is not')
    } finally {
      if (previous === undefined) delete process.env.VERBS_DIR
      else process.env.VERBS_DIR = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})
