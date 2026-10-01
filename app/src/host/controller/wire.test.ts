import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decode } from '../../lib/contract/decode'
import type { Methods } from './generated'
import { ANSWERS, ControllerError, eventOf, parseLine, requestLine } from './wire'

// The controller's wire against the agent's own fixtures
// (./generated/fixtures/, which agent/src/api/wire.rs writes from its golden
// tests' values): every answer decodes with its method's decoder to exactly
// what the agent wrote, so a reader that stops understanding the writer — or
// reads less than it writes — fails here.

const dir = new URL('./generated/fixtures/', import.meta.url)
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'))
const names = readdirSync(dir).map((f) => f.replace(/\.json$/, ''))
const isMethod = (n: string): n is keyof Methods => Object.hasOwn(ANSWERS, n)

describe('the controller wire', () => {
  it('writes requests the agent parses: a method that takes nothing carries no p', () => {
    expect(requestLine(7, 'hello', { api: 1, client: 'daedalus-app/2026.9' })).toBe(
      '{"id":7,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}\n',
    )
    expect(requestLine(8, 'system.info', null)).toBe('{"id":8,"m":"system.info"}\n')
  })

  it('reads answers and errors', () => {
    expect(parseLine('{"id":1,"ok":{}}')).toEqual({ kind: 'ok', id: 1, ok: {} })
    const e = parseLine('{"id":2,"err":{"code":"unknown_method","msg":"no method x"}}')
    expect(e.kind === 'err' && e.id === 2 && e.error.code === 'unknown_method').toBe(true)
    const n = parseLine('{"id":null,"err":{"code":"bad_request","msg":"not JSON"}}')
    expect(n.kind === 'err' && n.id === null && n.error.code === 'bad_request').toBe(true)
    const v = parseLine(JSON.stringify(fixture('error.version')))
    expect(v.kind === 'err' && v.error.code === 'version' && v.error.supported === 1).toBe(true)
  })

  it('names a code it does not know as a protocol error, and refuses what is not a line', () => {
    const m = parseLine('{"id":4,"err":{"code":"shiny","msg":"new"}}')
    expect(m.kind === 'err' && m.error.code === 'protocol').toBe(true)
    for (const bad of ['not json', '[1,2]', '{"id":1}', 'null']) {
      expect(() => parseLine(bad), bad).toThrow(ControllerError)
    }
  })
})

describe('the answers the agent writes', () => {
  const answers = names.filter((n) => !n.startsWith('event.') && !n.startsWith('error.'))

  it('has a fixture for every method', () => {
    expect([...answers].sort()).toEqual(Object.keys(ANSWERS).sort())
  })

  it.each(answers)('decodes %s to exactly what the agent wrote', (m) => {
    if (!isMethod(m)) throw new Error(`no method ${m}`)
    const f = fixture(m)
    expect(decode(ANSWERS[m] as (v: unknown, p: string) => unknown, f)).toEqual(f)
  })

  it('refuses an answer missing a field the agent always writes', () => {
    const { connected: _, ...list } = (fixture('nodes.list') as { nodes: object[] }).nodes[0] as {
      connected: boolean
    }
    expect(() => decode(ANSWERS['nodes.list'], { nodes: [list] })).toThrow()
    const { telemetry: __, ...detail } = fixture('nodes.get') as Record<string, unknown>
    expect(() => decode(ANSWERS['nodes.get'], detail)).toThrow()
  })
})

describe('the events the agent pushes', () => {
  it.each(names.filter((n) => n.startsWith('event.')))('decodes %s', (n) => {
    const line = fixture(n) as { e: string; p: unknown }
    expect(eventOf(line.e, line.p)).toEqual(line)
  })

  it('refuses an event it does not know, and a payload that is not a node id', () => {
    expect(() => eventOf('nodes.changed', { id: '0123456789abcdef' })).toThrow(ControllerError)
    expect(() => eventOf('nodes.left', { id: '../etc' })).toThrow(ControllerError)
    expect(() => eventOf('nodes.policy_request', { id: '0123456789abcdef', changes: 7 })).toThrow(
      ControllerError,
    )
  })
})
