import { describe, expect, it } from 'vitest'
import {
  ControllerError,
  claudeStatus,
  helloOk,
  parseLine,
  queued,
  requestLine,
  systemInfo,
  telemetryGet,
} from './wire'

// The golden lines agent/src/api/wire.rs pins, copied exactly: if the agent's
// JSON moves without an API version bump, its tests fail; if this reader
// stops understanding it, these do.

const ok = (line: string): unknown => {
  const m = parseLine(line)
  if (m.kind !== 'ok') throw new Error(`not an answer: ${line}`)
  return m.ok
}

describe('the controller wire', () => {
  it('writes requests the agent parses', () => {
    expect(requestLine(7, 'hello', { api: 1, client: 'daedalus-app/2026.9' })).toBe(
      '{"id":7,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}\n',
    )
    expect(requestLine(8, 'system.info')).toBe('{"id":8,"m":"system.info"}\n')
  })

  it('reads answers and errors', () => {
    expect(parseLine('{"id":1,"ok":{}}')).toEqual({ kind: 'ok', id: 1, ok: {} })
    const e = parseLine('{"id":2,"err":{"code":"unknown_method","msg":"no method x"}}')
    expect(e.kind).toBe('err')
    if (e.kind !== 'err') return
    expect(e.id).toBe(2)
    expect(e.error.code).toBe('unknown_method')
    expect(e.error.message).toBe('no method x')
    const n = parseLine('{"id":null,"err":{"code":"bad_request","msg":"not JSON"}}')
    expect(n.kind === 'err' && n.id === null && n.error.code === 'bad_request').toBe(true)
    const v = parseLine(
      '{"id":3,"err":{"code":"version","msg":"this agent speaks api 1","supported":1}}',
    )
    expect(v.kind === 'err' && v.error.code === 'version' && v.error.supported === 1).toBe(true)
  })

  it('names a code it does not know as a protocol error, and refuses what is not a line', () => {
    const m = parseLine('{"id":4,"err":{"code":"shiny","msg":"new"}}')
    expect(m.kind === 'err' && m.error.code === 'protocol').toBe(true)
    for (const bad of ['not json', '[1,2]', '{"id":1}', 'null']) {
      expect(() => parseLine(bad), bad).toThrow(ControllerError)
    }
  })

  it('reads events', () => {
    expect(
      parseLine('{"e":"claude.changed","p":{"reporting":true,"state":"starting","pid":7}}'),
    ).toEqual({
      kind: 'event',
      e: 'claude.changed',
      p: { reporting: true, state: 'starting', pid: 7 },
    })
  })

  it('decodes hello', () => {
    expect(
      helloOk(
        ok(
          '{"id":1,"ok":{"api":1,"version":"0.13.0","mode":"controller","hostname":"box","capabilities":["claude.remote_control","telemetry.full"]}}',
        ),
      ),
    ).toEqual({
      api: 1,
      version: '0.13.0',
      mode: 'controller',
      hostname: 'box',
      capabilities: ['claude.remote_control', 'telemetry.full'],
    })
  })

  it('decodes system.info', () => {
    const line = [
      '{"id":2,"ok":',
      '{"api":1,"version":"0.13.0","mode":"controller","hostname":"box",',
      '"os":{"os":"linux","name":"NixOS","version":"25.11","arch":"x86_64","cpu":"AMD Ryzen 7","memory_bytes":64},',
      '"uptime_secs":5,"os_uptime_secs":100,"booted_at":"2026-09-27T10:00:00Z",',
      '"role":{"mode":"controller","hello":false,"self_update":false,"keep_awake":false,',
      '"installer":false,"session":true,"session_in_service":true,"claude_update":false,',
      '"tray":false,"status_on_lan":false,"api_socket":true},',
      '"telemetry":"minimal","capabilities":["claude.remote_control","telemetry.minimal"]}',
      '}',
    ].join('')
    expect(systemInfo(ok(line))).toEqual({
      api: 1,
      version: '0.13.0',
      mode: 'controller',
      hostname: 'box',
      os: {
        os: 'linux',
        name: 'NixOS',
        version: '25.11',
        arch: 'x86_64',
        cpu: 'AMD Ryzen 7',
        memoryBytes: 64,
      },
      uptimeSecs: 5,
      osUptimeSecs: 100,
      bootedAt: '2026-09-27T10:00:00Z',
      role: {
        mode: 'controller',
        hello: false,
        selfUpdate: false,
        keepAwake: false,
        installer: false,
        session: true,
        sessionInService: true,
        claudeUpdate: false,
        tray: false,
        statusOnLan: false,
        apiSocket: true,
      },
      telemetry: 'minimal',
      capabilities: ['claude.remote_control', 'telemetry.minimal'],
    })
  })

  it('ignores fields it does not know', () => {
    const s = systemInfo({
      api: 1,
      version: '0.14.0',
      mode: 'controller',
      hostname: 'box',
      os: { os: 'linux', future: 1 },
      role: { api_socket: true, relay: true },
      telemetry: 'full',
      capabilities: [],
      machines: [],
    })
    expect(s.os.name).toBe('')
    expect(s.role.apiSocket).toBe(true)
    expect(s.uptimeSecs).toBe(0)
  })

  it('decodes claude.status, silent and reporting', () => {
    expect(claudeStatus(JSON.parse('{"reporting":false,"wanted":true,"report":null}'))).toEqual({
      reporting: false,
      wanted: true,
      report: null,
    })
    const live = claudeStatus(
      JSON.parse(
        [
          '{"reporting":true,"wanted":true,"report":{',
          '"path":null,"install_method":null,"cli_version":null,"last_update":null,',
          '"state":"running","detail":null,"pid":4242,"started_at":null,"restarts":0,',
          '"last_exit":null,',
          '"server":{"version":null,"environment_id":null,"spawn_mode":null,"max_sessions":null},',
          '"sessions":[],',
          '"credentials":{"present":false,"store":null,"subscription_type":null,',
          '"rate_limit_tier":null,"expires_at":null,"refresh_expires_at":null},',
          '"settings":{"model":null,"effort_level":null},',
          '"user":null,"home":null,"workdir":null,"workdir_via":null,"log":null,',
          '"reported_at":"2026-09-27T10:00:00Z"}}',
        ].join(''),
      ),
    )
    expect(live.reporting).toBe(true)
    expect(live.report?.state).toBe('running')
    expect(live.report?.pid).toBe(4242)
    expect(live.report?.reportedAt).toBe('2026-09-27T10:00:00Z')
  })

  it('decodes claude.restart', () => {
    expect(queued(JSON.parse('{"queued":true}'))).toEqual({ queued: true })
  })

  it('decodes telemetry.get, off and minimal', () => {
    expect(telemetryGet(JSON.parse('{"level":"off","telemetry":null}'))).toEqual({
      level: 'off',
      telemetry: null,
    })
    const t = telemetryGet(
      JSON.parse(
        [
          '{"level":"minimal","telemetry":{"sampled_at":"2026-09-27T10:00:15Z",',
          '"machine":{"manufacturer":null,"model":null,"chip":null,"bios_vendor":null,',
          '"bios_version":null,"bios_date":null,"board_manufacturer":null,"board_product":null,',
          '"form":null,"target":null},',
          '"os":{"kernel":null,"build":null,"installed_at":null},',
          '"cpu":{"model":null,"cores":null,"threads":null,"frequency_mhz":null,"usage_pct":null,',
          '"load":null,"temperature_c":null},',
          '"memory":{"total_bytes":null,"used_bytes":null,"available_bytes":null,"cached_bytes":null,',
          '"compressed_bytes":null,"committed_bytes":null,"commit_limit_bytes":null,',
          '"swap_total_bytes":null,"swap_used_bytes":null,"slots":null,"max_capacity_bytes":null,',
          '"modules":[]},',
          '"disks":[],"drives":[],"gpus":[],"temperatures":[],"network":[],"battery":null,',
          '"processes":[],"process_count":null,"services":[],"service_count":null,',
          '"browsers":[],"apps":[],"app_count":null,"updates":null,"providers":[],"errors":[]}}',
        ].join(''),
      ),
    )
    expect(t.level).toBe('minimal')
    expect(t.telemetry).not.toBeNull()
    expect(t.telemetry?.sampledAt).toBe('2026-09-27T10:00:15Z')
  })
})
