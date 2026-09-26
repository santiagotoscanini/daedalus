import { describe, expect, it } from 'vitest'
import { NODE_NAME_RE, parseNodesFile, renderNodesFile, slugOf } from './nodes-file'

describe('a node’s name', () => {
  it('is the hostname as a DNS label', () => {
    expect(slugOf("Santiago's MacBook Pro (2)")).toBe('santiagos-macbook-pro-2')
    expect(slugOf('SANTI-PC')).toBe('santi-pc')
    expect(slugOf('--x--')).toBe('x')
    expect(slugOf('a'.repeat(40))).toHaveLength(32)
    expect(slugOf('')).toBe('')
  })
  it('accepts labels and refuses the rest', () => {
    for (const ok of ['gaming-pc', 'a', 'mac2', 'x'.repeat(32)])
      expect(NODE_NAME_RE.test(ok), ok).toBe(true)
    for (const bad of ['', '-pc', 'pc-', 'Gaming', 'a.b', 'x'.repeat(33)]) {
      expect(NODE_NAME_RE.test(bad), bad).toBe(false)
    }
  })
})

describe('nodes.json', () => {
  const nodes = [
    {
      id: 'a2272f1b0bdac468',
      name: 'gaming-pc',
      os: 'windows',
      providers: { lemonade: { port: 13305, offer: true } },
    },
    {
      id: '07122fc9eb01b748',
      name: 'macbook-pro',
      os: 'macos',
      providers: { lemonade: { port: 13305, offer: false } },
    },
  ]
  it('renders sorted by id, offered providers only, and reads back', () => {
    const text = renderNodesFile(nodes)
    expect(text.endsWith('\n')).toBe(true)
    const doc = parseNodesFile(JSON.parse(text))
    expect(doc.nodes.map((n) => n.id)).toEqual(['07122fc9eb01b748', 'a2272f1b0bdac468'])
    expect(doc.nodes[0]?.providers).toEqual({})
    expect(doc.nodes[1]?.providers).toEqual({ lemonade: { port: 13305 } })
    // Byte-identical to the site-format sample the nix side builds against.
    expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`)
  })
  it('refuses another schema, a bad label and a repeated name', () => {
    expect(() => parseNodesFile({ schemaVersion: 2, nodes: [] })).toThrow(/schemaVersion 2/)
    expect(() =>
      parseNodesFile({ schemaVersion: 1, nodes: [{ id: 'a', name: 'Bad Name', os: 'linux' }] }),
    ).toThrow(/DNS label/)
    expect(() =>
      parseNodesFile({
        schemaVersion: 1,
        nodes: [
          { id: 'a', name: 'pc', os: 'linux' },
          { id: 'b', name: 'pc', os: 'linux' },
        ],
      }),
    ).toThrow(/two nodes/)
  })
})
