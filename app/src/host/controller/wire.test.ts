import { describe, expect, it } from 'vitest'
import {
  ControllerError,
  claudeRosterGet,
  claudeSessionSent,
  claudeStatus,
  commandOk,
  helloOk,
  nodeClaudeAnswer,
  nodeClaudeRosterAnswer,
  nodeDetail,
  nodesList,
  nodeTelemetryAnswer,
  parseLine,
  queued,
  requestLine,
  sessionQueued,
  setDesiredOk,
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
      '"role":{"mode":"controller","link":false,"self_update":false,"keep_awake":false,',
      '"installer":false,"session":true,"session_in_service":true,"claude_update":false,',
      '"tray":false,"status_on_lan":true,"api_socket":true,"node_listener":true},',
      '"telemetry":"minimal","capabilities":["claude.remote_control","telemetry.minimal","nodes"],',
      '"controller":{"public_key":"abababababababababababababababababababababababababababababababab",',
      '"fingerprint":"3f2a:9c01","listen":"0.0.0.0:7788","advertise":["box.lan:7788"]}}',
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
        link: false,
        selfUpdate: false,
        keepAwake: false,
        installer: false,
        session: true,
        sessionInService: true,
        claudeUpdate: false,
        tray: false,
        statusOnLan: true,
        apiSocket: true,
        nodeListener: true,
      },
      telemetry: 'minimal',
      capabilities: ['claude.remote_control', 'telemetry.minimal', 'nodes'],
      controller: {
        publicKey: 'ab'.repeat(32),
        fingerprint: '3f2a:9c01',
        listen: '0.0.0.0:7788',
        advertise: ['box.lan:7788'],
      },
    })
    // Anywhere but the controller the block is absent, not null.
    const bare = JSON.parse(line.slice('{"id":2,"ok":'.length, -1)) as Record<string, unknown>
    delete bare.controller
    expect(systemInfo(bare).controller).toBeNull()
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
          '"rate_limit_tier":null,"expires_at":null,"refresh_expires_at":null,"scopes":[]},',
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

  // ── the machines ──────────────────────────────────────────────────────────

  const SUMMARY = [
    '"id":"0123456789abcdef","fingerprint":"0123:4567","state":"approved","connected":true,',
    '"since":"2026-09-27T10:00:00Z","last_seen":"2026-09-27T10:00:15Z","hostname":"PC",',
    '"os":"windows","arch":"x86_64","agent_version":"0.14.0","lan_ip":"192.168.0.120",',
    '"mac":"aa:bb:cc:dd:ee:ff","claude":{"state":"running","detail":null,"cli_version":null,',
    '"server_version":null,"sessions":2,"started_at":null,"signed_in":true}',
  ].join('')

  const PC = {
    id: '0123456789abcdef',
    fingerprint: '0123:4567',
    state: 'approved',
    connected: true,
    since: '2026-09-27T10:00:00Z',
    lastSeen: '2026-09-27T10:00:15Z',
    hostname: 'PC',
    os: 'windows',
    arch: 'x86_64',
    agentVersion: '0.14.0',
    lanIp: '192.168.0.120',
    mac: 'aa:bb:cc:dd:ee:ff',
    claude: {
      state: 'running',
      detail: null,
      cliVersion: null,
      serverVersion: null,
      sessions: 2,
      startedAt: null,
      signedIn: true,
    },
  }

  it('decodes nodes.list, a connected machine and one never seen', () => {
    expect(nodesList(ok(`{"id":5,"ok":{"nodes":[{${SUMMARY}}]}}`))).toEqual([PC])
    const unseen = nodesList(
      JSON.parse(
        [
          '{"nodes":[{"id":"0123456789abcdef","fingerprint":"0123:4567","state":"unknown","connected":false,',
          '"since":null,"last_seen":null,"hostname":null,"os":null,"arch":null,"agent_version":null,',
          '"lan_ip":null,"mac":null,"claude":null}]}',
        ].join(''),
      ),
    )
    expect(unseen[0]).toMatchObject({
      state: 'unknown',
      connected: false,
      hostname: null,
      claude: null,
    })
    expect(nodesList(JSON.parse('{"nodes":[]}'))).toEqual([])
  })

  it('decodes nodes.get, and a status document it cannot read as none', () => {
    const d = nodeDetail(
      JSON.parse(
        `{${SUMMARY},"public_key":"${'ab'.repeat(32)}","hello":null,"status":{"awake_hold":true},"status_at":"2026-09-27T10:00:15Z","telemetry":null,"telemetry_at":null,"providers":[]}`,
      ),
    )
    expect(d).toMatchObject({ ...PC, publicKey: 'ab'.repeat(32), hello: null, telemetry: null })
    expect(d.statusAt).toBe('2026-09-27T10:00:15Z')
    // The golden status is a fragment; a real one carries the agent's version.
    expect(d.status).toBeNull()

    const full = nodeDetail({
      ...JSON.parse(`{${SUMMARY}}`),
      public_key: 'ab'.repeat(32),
      hello: JSON.parse(
        [
          '{"proto":1,"node_id":"0123456789abcdef","agent_version":"0.14.0","os":"windows",',
          '"arch":"x86_64","hostname":"PC","mac":"aa:bb:cc:dd:ee:ff","lan_ip":"192.168.0.120",',
          '"facts":{"os_name":"Windows 11 Pro","os_version":"24H2",',
          '"cpu":"AMD Ryzen 9","memory_bytes":64},',
          '"capabilities":["claude.remote_control","telemetry.full"],"telemetry":"full"}',
        ].join(''),
      ),
      status: {
        version: '0.14.0',
        hostname: 'PC',
        awake_hold: true,
        controller: {
          path: 'controller',
          state: 'approved',
          connected: true,
          fingerprint: 'aaaa:bbbb',
          controller_fingerprint: 'f3e5:a403',
          pinned_via: 'tofu',
          unconfirmed: true,
          conflict: null,
          error: null,
        },
      },
      status_at: null,
      telemetry: null,
      telemetry_at: null,
      providers: [],
    })
    expect(full.hello).toEqual({
      agentVersion: '0.14.0',
      os: 'windows',
      arch: 'x86_64',
      hostname: 'PC',
      mac: 'aa:bb:cc:dd:ee:ff',
      lanIp: '192.168.0.120',
      facts: { osName: 'Windows 11 Pro', osVersion: '24H2', cpu: 'AMD Ryzen 9', memoryBytes: 64 },
      capabilities: ['claude.remote_control', 'telemetry.full'],
      telemetry: 'full',
    })
    expect(full.status?.version).toBe('0.14.0')
    expect(full.status?.link).toMatchObject({
      fingerprint: 'aaaa:bbbb',
      controllerFingerprint: 'f3e5:a403',
      pinnedVia: 'tofu',
      unconfirmed: true,
    })
  })

  it('decodes nodes.telemetry and nodes.claude', () => {
    expect(
      nodeTelemetryAnswer(
        JSON.parse('{"id":"0123456789abcdef","telemetry":null,"received_at":null}'),
      ),
    ).toEqual({ telemetry: null, receivedAt: null })
    expect(
      nodeClaudeAnswer(JSON.parse('{"id":"0123456789abcdef","report":null,"received_at":"t"}')),
    ).toEqual({ report: null, receivedAt: 't' })
  })

  it('decodes nodes.set_desired and nodes.command', () => {
    expect(
      setDesiredOk(
        JSON.parse(
          '{"nodes":2,"approved":["0123456789abcdef"],"revoked":[],"pending":[],"policy":["fedcba9876543210"]}',
        ),
      ),
    ).toEqual({
      nodes: 2,
      approved: ['0123456789abcdef'],
      revoked: [],
      pending: [],
      policy: ['fedcba9876543210'],
    })
    expect(commandOk(JSON.parse('{"delivered":true,"queued":false}'))).toEqual({
      delivered: true,
      queued: false,
    })
  })

  it('knows not_found, and the nodes events', () => {
    const m = parseLine('{"id":9,"err":{"code":"not_found","msg":"no machine 0123456789abcdef"}}')
    expect(m.kind === 'err' && m.error.code === 'not_found').toBe(true)
    expect(
      parseLine(
        '{"e":"nodes.pending","p":{"id":"0123456789abcdef","fingerprint":"0123:4567","hostname":"PC"}}',
      ),
    ).toMatchObject({ kind: 'event', e: 'nodes.pending' })
  })
  // wire.rs `ROSTER`: a roster with one of everything, every field the app reads.
  const ROSTER = [
    '{"reported_at":"2026-09-27T10:00:00Z","agents_available":true,',
    '"agents":[{"id":"0a1b2c3d","session_id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","pid":null,',
    '"kind":"background","state":"blocked","status":null,"name":"nixos-7a","cwd":"/etc/nixos","started_at":1}],',
    '"transcripts":[{"id":"abdda3a9-0cb2-43f1-b13e-37f25a755fce","project":"-etc-nixos","cwd":"/etc/nixos",',
    '"cwd_exact":true,"title":"Fix the build","title_source":"custom-title","started_at":2,',
    '"modified_at":3000,"size_bytes":4,"meta":{"exchanges":5,"replies":6,"thinking":7,"images":0,',
    '"attached":1,"subagents":null,"span_ms":8,"branch":"main","cli_version":"2.1.281",',
    '"last_prompt":"ship it","cost":{"usd":1.5,"lines_added":9,"lines_removed":null,"duration_ms":null}}}],',
    '"transcript_total":1,"empty_count":2,"truncated":false,',
    '"managed":[{"id":"bbdda3a9-0cb2-43f1-b13e-37f25a755fce","unit":"claude-session-bbdda3a9-0cb2-43f1-b13e-37f25a755fce",',
    '"pid":42,"memory_bytes":10,"cpu_nsec":null,"log":"/l","log_bytes":11}],',
    '"resume_unavailable":null,',
    '"session_stats":[{"pid":42,"cpu_ms":12,"rss_bytes":13,"log_bytes":null,"bridge_at":null}],',
    '"server":{"memory_bytes":14,"cpu_nsec":15},',
    '"actions":[{"request":"00112233445566ff","action":"stop","id":"0a1b2c3d","state":"done",',
    '"detail":"stopped","started_at":"t0","finished_at":"t1"}],"errors":[]}',
  ].join('')

  it('decodes claude.roster into the page’s shapes, and a silent one', () => {
    expect(claudeRosterGet(JSON.parse('{"reporting":false,"roster":null}'))).toEqual({
      reporting: false,
      roster: null,
    })
    const r = claudeRosterGet(JSON.parse(`{"reporting":true,"roster":${ROSTER}}`)).roster
    expect(r?.roster.agents[0]).toEqual({
      id: '0a1b2c3d',
      sessionId: 'abdda3a9-0cb2-43f1-b13e-37f25a755fce',
      pid: null,
      kind: 'background',
      state: 'blocked',
      status: null,
      name: 'nixos-7a',
      cwd: '/etc/nixos',
      startedAt: 1,
    })
    expect(r?.roster.transcripts[0]).toMatchObject({
      id: 'abdda3a9-0cb2-43f1-b13e-37f25a755fce',
      cwdExact: true,
      titleSource: 'custom-title',
      modifiedAt: 3000,
    })
    expect(r?.roster.transcripts[0]?.meta).toEqual({
      exchanges: 5,
      replies: 6,
      thinking: 7,
      images: 0,
      attached: 1,
      subagents: null,
      spanMs: 8,
      branch: 'main',
      cliVersion: '2.1.281',
      lastPrompt: 'ship it',
      cost: { usd: 1.5, linesAdded: 9, linesRemoved: null, durationMs: null },
    })
    expect(r?.roster.managedIds).toEqual(['bbdda3a9-0cb2-43f1-b13e-37f25a755fce'])
    expect(r?.roster.resumeUnavailable).toBeNull()
    expect(r?.roster.transcriptTotal).toBe(1)
    expect(r?.roster.emptyCount).toBe(2)
    expect(r?.sessionStats).toEqual([
      { pid: 42, cpuMs: 12, rssBytes: 13, logBytes: null, bridgeAt: null },
    ])
    expect(r?.server).toEqual({ memoryBytes: 14, cpuNsec: 15 })
    expect(r?.actions).toEqual([
      {
        request: '00112233445566ff',
        action: 'stop',
        session: '0a1b2c3d',
        state: 'done',
        detail: 'stopped',
        startedAt: 't0',
        finishedAt: 't1',
      },
    ])
  })

  it('decodes nodes.claude_roster, and a machine without resume', () => {
    const noResume = ROSTER.replace(
      '"resume_unavailable":null',
      '"resume_unavailable":"the session is the tray\'s child"',
    )
    const a = nodeClaudeRosterAnswer(
      JSON.parse(`{"id":"0123456789abcdef","roster":${noResume},"received_at":"t"}`),
    )
    expect(a.receivedAt).toBe('t')
    expect(a.roster?.roster.resumeUnavailable).toBe("the session is the tray's child")
    expect(
      nodeClaudeRosterAnswer(
        JSON.parse('{"id":"0123456789abcdef","roster":null,"received_at":null}'),
      ),
    ).toEqual({ roster: null, receivedAt: null })
  })

  it('decodes the two session-verb answers to their request id', () => {
    expect(sessionQueued(JSON.parse('{"queued":true,"request":"00112233445566ff"}'))).toEqual({
      request: '00112233445566ff',
    })
    expect(
      claudeSessionSent(JSON.parse('{"delivered":true,"request":"00112233445566ff"}')),
    ).toEqual({ request: '00112233445566ff' })
  })
})
