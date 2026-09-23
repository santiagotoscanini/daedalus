import { arrayOf, bool, decode, int, nullable, num, obj, optional, str } from '../contract/decode'

// The agent's status page, as the box reads it (agent/src/status.rs is the
// writer). One JSON document on TCP 7787 of a machine the box does not run;
// this is the half of it the box acts on. Fields the agent adds later are
// ignored until a reader here wants them, and fields an older agent lacks
// decode to their fallbacks, so a fleet of mixed agent versions reads.

/** The port every agent answers on unless its config says otherwise. */
export const AGENT_PORT = 7787

/** What the box asked of the machine, as the agent holds it (agent 0.4.0+). */
export type AgentPolicy = {
  awakeHold: boolean
  claudeRemoteControl: boolean
}

/** One session on the node, from its `~/.claude/sessions` (agent/src/claude.rs). */
export type NodeClaudeSession = {
  pid: number
  transcriptId: string | null
  remoteId: string | null
  cwd: string | null
  name: string | null
  kind: string | null
  entrypoint: string | null
  version: string | null
  startedAt: number | null
  status: string | null
  lastActivityAt: number | null
  alive: boolean
}

/**
 * Claude Code on the node, as its tray reported it: the supervised
 * `claude remote-control`, the sessions, the credential clock (dates and a
 * plan name, never a token) and the model settings. Mirrors the box's own
 * ClaudeFacts where the two can agree.
 */
export type NodeClaude = {
  path: string | null
  cliVersion: string | null
  /** not-installed | off | starting | running | waiting | stopped */
  state: string
  detail: string | null
  pid: number | null
  startedAt: string | null
  restarts: number
  lastExit: string | null
  server: {
    version: string | null
    environmentId: string | null
    spawnMode: string | null
    maxSessions: number | null
  }
  sessions: NodeClaudeSession[]
  credentials: {
    present: boolean
    /** "file" or "keychain" (macOS: present, but the dates are not readable). */
    store: string | null
    subscriptionType: string | null
    rateLimitTier: string | null
    expiresAt: number | null
    refreshExpiresAt: number | null
  }
  settings: { model: string | null; effortLevel: string | null }
  user: string | null
  home: string | null
  workdir: string | null
  /** "named", "most recent trusted project", or the home fallback with its reason. */
  workdirVia: string | null
  log: string | null
  reportedAt: string
}

/**
 * Claude Code on the node as the OPEN status page states it: a state,
 * versions, a count. The agent keeps everything a stranger on the LAN
 * should not read — session names, paths, ids, the environment id, the
 * login's dates — for `/claude`, which only the box's token opens
 * (`nodeClaudeReport` below).
 */
export type NodeClaudeSummary = {
  state: string
  detail: string | null
  cliVersion: string | null
  serverVersion: string | null
  sessions: number
  startedAt: string | null
  signedIn: boolean
}

const nstr = optional(nullable(str), null)
const nint = optional(nullable(int), null)
const nnum = optional(nullable(num), null)

const summary = obj({
  state: optional(str, 'stopped'),
  detail: nstr,
  cli_version: nstr,
  server_version: nstr,
  sessions: optional(int, 0),
  started_at: nstr,
  signed_in: optional(bool, false),
})

export type AgentStatus = {
  version: string
  hostname: string
  os: string
  /** "Windows 11 Pro", "macOS"; empty from an agent older than 0.3.0. */
  osName: string
  /** "24H2 (26100.4652)", "15.1"; empty from an older agent. */
  osVersion: string
  arch: string
  cpu: string
  memoryBytes: number | null
  /** The agent process's uptime. */
  uptimeSecs: number
  /** The machine's; null from an agent older than 0.2.1. */
  osUptimeSecs: number | null
  bootedAt: string | null
  awakeHold: boolean
  holdError: string | null
  updateAvailable: string | null
  restartPending: boolean
  lastUpdateCheck: string | null
  lastUpdateResult: string | null
  /** The agent's policy; an agent older than 0.4.0 holds the machine awake and has no Claude. */
  policy: AgentPolicy
  /** Null when the tray has not reported lately (nobody logged on), or the agent predates it. */
  claude: NodeClaudeSummary | null
  /** Whether the tray — the user's session — is reporting to the service. */
  trayReporting: boolean
}

const session = obj({
  pid: int,
  transcript_id: nstr,
  remote_id: nstr,
  cwd: nstr,
  name: nstr,
  kind: nstr,
  entrypoint: nstr,
  version: nstr,
  started_at: nnum,
  status: nstr,
  last_activity_at: nnum,
  alive: optional(bool, false),
})

const claude = obj({
  path: nstr,
  cli_version: nstr,
  state: optional(str, 'stopped'),
  detail: nstr,
  pid: nint,
  started_at: nstr,
  restarts: optional(int, 0),
  last_exit: nstr,
  server: optional(
    obj({
      version: nstr,
      environment_id: nstr,
      spawn_mode: nstr,
      max_sessions: nint,
    }),
    { version: null, environment_id: null, spawn_mode: null, max_sessions: null },
  ),
  sessions: optional(arrayOf(session), []),
  credentials: optional(
    obj({
      present: optional(bool, false),
      store: nstr,
      subscription_type: nstr,
      rate_limit_tier: nstr,
      expires_at: nnum,
      refresh_expires_at: nnum,
    }),
    {
      present: false,
      store: null,
      subscription_type: null,
      rate_limit_tier: null,
      expires_at: null,
      refresh_expires_at: null,
    },
  ),
  settings: optional(obj({ model: nstr, effort_level: nstr }), { model: null, effort_level: null }),
  user: nstr,
  home: nstr,
  workdir: nstr,
  workdir_via: nstr,
  log: nstr,
  reported_at: optional(str, ''),
})

const shape = obj({
  version: str,
  hostname: optional(str, ''),
  os: optional(str, ''),
  os_name: optional(str, ''),
  os_version: optional(str, ''),
  arch: optional(str, ''),
  cpu: optional(str, ''),
  memory_bytes: nint,
  uptime_secs: optional(int, 0),
  os_uptime_secs: nint,
  booted_at: nstr,
  awake_hold: optional(bool, false),
  hold_error: nstr,
  update_available: nstr,
  restart_pending: optional(bool, false),
  last_update_check: nstr,
  last_update_result: nstr,
  policy: optional(
    obj({
      awake_hold: optional(bool, true),
      claude_remote_control: optional(bool, false),
    }),
    { awake_hold: true, claude_remote_control: false },
  ),
  claude: optional(nullable(summary), null),
  tray: optional(obj({ reporting: optional(bool, false) }), { reporting: false }),
})

function nodeClaude(c: NonNullable<ReturnType<typeof claude>>): NodeClaude {
  return {
    path: c.path,
    cliVersion: c.cli_version,
    state: c.state,
    detail: c.detail,
    pid: c.pid,
    startedAt: c.started_at,
    restarts: c.restarts,
    lastExit: c.last_exit,
    server: {
      version: c.server.version,
      environmentId: c.server.environment_id,
      spawnMode: c.server.spawn_mode,
      maxSessions: c.server.max_sessions,
    },
    sessions: c.sessions.map((s) => ({
      pid: s.pid,
      transcriptId: s.transcript_id,
      remoteId: s.remote_id,
      cwd: s.cwd,
      name: s.name,
      kind: s.kind,
      entrypoint: s.entrypoint,
      version: s.version,
      startedAt: s.started_at,
      status: s.status,
      lastActivityAt: s.last_activity_at,
      alive: s.alive,
    })),
    credentials: {
      present: c.credentials.present,
      store: c.credentials.store,
      subscriptionType: c.credentials.subscription_type,
      rateLimitTier: c.credentials.rate_limit_tier,
      expiresAt: c.credentials.expires_at,
      refreshExpiresAt: c.credentials.refresh_expires_at,
    },
    settings: { model: c.settings.model, effortLevel: c.settings.effort_level },
    user: c.user,
    home: c.home,
    workdir: c.workdir,
    workdirVia: c.workdir_via,
    log: c.log,
    reportedAt: c.reported_at,
  }
}

/** Decode a status document; throws on a body that is not one. */
export function agentStatus(body: unknown): AgentStatus {
  const s = decode(shape, body)
  return {
    version: s.version,
    hostname: s.hostname,
    os: s.os,
    osName: s.os_name,
    osVersion: s.os_version,
    arch: s.arch,
    cpu: s.cpu,
    memoryBytes: s.memory_bytes,
    uptimeSecs: s.uptime_secs,
    osUptimeSecs: s.os_uptime_secs,
    bootedAt: s.booted_at,
    awakeHold: s.awake_hold,
    holdError: s.hold_error,
    updateAvailable: s.update_available,
    restartPending: s.restart_pending,
    lastUpdateCheck: s.last_update_check,
    lastUpdateResult: s.last_update_result,
    policy: { awakeHold: s.policy.awake_hold, claudeRemoteControl: s.policy.claude_remote_control },
    claude: s.claude === null ? null : summaryOf(s.claude),
    trayReporting: s.tray.reporting,
  }
}

/** Whether this agent version reports Claude Code and takes a policy (0.4.0 and up). */
export function agentHasClaude(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((p) => Number.parseInt(p, 10))
  return major > 0 || minor >= 4
}

function summaryOf(s: ReturnType<typeof summary>): NodeClaudeSummary {
  return {
    state: s.state,
    detail: s.detail,
    cliVersion: s.cli_version,
    serverVersion: s.server_version,
    sessions: s.sessions,
    startedAt: s.started_at,
    signedIn: s.signed_in,
  }
}

/**
 * Decode the agent's `/claude` — the full report, which the agent answers
 * only on loopback or to the box's node token. Null when the tray has not
 * reported lately.
 */
export function nodeClaudeReport(body: unknown): NodeClaude | null {
  if (body === null) return null
  return nodeClaude(decode(claude, body))
}

// ── telemetry (agent 0.7.0+) ────────────────────────────────────────────────
//
// What the machine is and how it is doing, sampled by the agent every 15 s
// (agent/src/telemetry.rs). Every field the agent could not read is null or
// an empty list, and `errors` says why, so a page draws a reason rather than
// a dash. Decoded loosely on purpose: a field an older agent lacks is null.

export type NodeTelemetry = {
  sampledAt: string
  machine: {
    manufacturer: string | null
    model: string | null
    chip: string | null
    biosVendor: string | null
    biosVersion: string | null
    biosDate: string | null
    boardManufacturer: string | null
    boardProduct: string | null
    /** "laptop" | "desktop" | "tower" | "mini" | "all-in-one" | "server" | "tablet". */
    form: string | null
  }
  os: { kernel: string | null; build: string | null; installedAt: string | null }
  cpu: {
    model: string | null
    cores: number | null
    threads: number | null
    frequencyMhz: number | null
    usagePct: number | null
    load: [number, number, number] | null
    temperatureC: number | null
  }
  memory: {
    totalBytes: number | null
    usedBytes: number | null
    availableBytes: number | null
    /** File cache the OS would drop under pressure. */
    cachedBytes: number | null
    /** Held compressed rather than swapped. */
    compressedBytes: number | null
    /** Windows: commit charge and its limit. */
    committedBytes: number | null
    commitLimitBytes: number | null
    swapTotalBytes: number | null
    swapUsedBytes: number | null
    /** Slots on the board (0 = soldered) and the firmware's ceiling. */
    slots: number | null
    maxCapacityBytes: number | null
    modules: NodeMemoryModule[]
  }
  disks: {
    mount: string
    name: string | null
    fs: string | null
    totalBytes: number | null
    usedBytes: number | null
    freeBytes: number | null
    kind: string | null
  }[]
  gpus: {
    name: string
    vendor: string | null
    driver: string | null
    vramTotalBytes: number | null
    vramUsedBytes: number | null
    usagePct: number | null
    temperatureC: number | null
    powerW: number | null
  }[]
  temperatures: { label: string; celsius: number }[]
  network: {
    interface: string
    rxBytes: number | null
    txBytes: number | null
    rxBps: number | null
    txBps: number | null
  }[]
  battery: { percent: number | null; charging: boolean | null; healthPct: number | null } | null
  /** The physical drives; serials only on the token-gated document. */
  drives: NodeDrive[]
  /** The heaviest by memory; empty on the open page. */
  processes: NodeProcess[]
  processCount: number | null
  /** Should be running and are not; empty on the open page. */
  services: NodeService[]
  serviceCount: number | null
  /** Null until the agent's first search, and on the open page. */
  updates: NodeUpdates | null
  errors: string[]
}

export type NodeMemoryModule = {
  locator: string | null
  sizeBytes: number | null
  speedMts: number | null
  kind: string | null
  manufacturer: string | null
  partNumber: string | null
}

export type NodeDrive = {
  name: string
  serial: string | null
  firmware: string | null
  sizeBytes: number | null
  bus: string | null
  kind: string | null
  /** "healthy" | "warning" | "unhealthy" | "verified" | "failing" | "not supported". */
  health: string | null
  temperatureC: number | null
  powerOnHours: number | null
  wearPct: number | null
  readErrors: number | null
  writeErrors: number | null
  removable: boolean | null
  volumes: string[]
}

export type NodeProcess = {
  name: string
  pid: number
  memoryBytes: number | null
  /** Percent of one core. */
  cpuPct: number | null
}

export type NodeService = {
  name: string
  display: string | null
  state: string
  exitCode: number | null
}

export type NodeUpdates = {
  checkedAt: string | null
  pending: {
    title: string
    id: string | null
    sizeBytes: number | null
    severity: string | null
    restart: boolean | null
  }[]
  installed: { title: string; at: string | null }[]
  rebootPending: boolean | null
  error: string | null
}

const nbool = optional(nullable(bool), null)

const telemetryShape = obj({
  sampled_at: optional(str, ''),
  machine: optional(
    obj({
      manufacturer: nstr,
      model: nstr,
      chip: nstr,
      bios_vendor: nstr,
      bios_version: nstr,
      bios_date: nstr,
      board_manufacturer: nstr,
      board_product: nstr,
      form: nstr,
    }),
    {
      manufacturer: null,
      model: null,
      chip: null,
      bios_vendor: null,
      bios_version: null,
      bios_date: null,
      board_manufacturer: null,
      board_product: null,
      form: null,
    },
  ),
  os: optional(obj({ kernel: nstr, build: nstr, installed_at: nstr }), {
    kernel: null,
    build: null,
    installed_at: null,
  }),
  cpu: optional(
    obj({
      model: nstr,
      cores: nint,
      threads: nint,
      frequency_mhz: nnum,
      usage_pct: nnum,
      load: optional(nullable(arrayOf(num)), null),
      temperature_c: nnum,
    }),
    {
      model: null,
      cores: null,
      threads: null,
      frequency_mhz: null,
      usage_pct: null,
      load: null,
      temperature_c: null,
    },
  ),
  memory: optional(
    obj({
      total_bytes: nnum,
      used_bytes: nnum,
      available_bytes: nnum,
      cached_bytes: nnum,
      compressed_bytes: nnum,
      committed_bytes: nnum,
      commit_limit_bytes: nnum,
      swap_total_bytes: nnum,
      swap_used_bytes: nnum,
      slots: nint,
      max_capacity_bytes: nnum,
      modules: optional(
        arrayOf(
          obj({
            locator: nstr,
            size_bytes: nnum,
            speed_mts: nnum,
            kind: nstr,
            manufacturer: nstr,
            part_number: nstr,
          }),
        ),
        [],
      ),
    }),
    {
      total_bytes: null,
      used_bytes: null,
      available_bytes: null,
      cached_bytes: null,
      compressed_bytes: null,
      committed_bytes: null,
      commit_limit_bytes: null,
      swap_total_bytes: null,
      swap_used_bytes: null,
      slots: null,
      max_capacity_bytes: null,
      modules: [],
    },
  ),
  disks: optional(
    arrayOf(
      obj({
        mount: optional(str, ''),
        name: nstr,
        fs: nstr,
        total_bytes: nnum,
        used_bytes: nnum,
        free_bytes: nnum,
        kind: nstr,
      }),
    ),
    [],
  ),
  gpus: optional(
    arrayOf(
      obj({
        name: optional(str, ''),
        vendor: nstr,
        driver: nstr,
        vram_total_bytes: nnum,
        vram_used_bytes: nnum,
        usage_pct: nnum,
        temperature_c: nnum,
        power_w: nnum,
      }),
    ),
    [],
  ),
  temperatures: optional(arrayOf(obj({ label: optional(str, ''), celsius: num })), []),
  network: optional(
    arrayOf(
      obj({
        interface: optional(str, ''),
        rx_bytes: nnum,
        tx_bytes: nnum,
        rx_bps: nnum,
        tx_bps: nnum,
      }),
    ),
    [],
  ),
  battery: optional(nullable(obj({ percent: nnum, charging: nbool, health_pct: nnum })), null),
  drives: optional(
    arrayOf(
      obj({
        name: optional(str, ''),
        serial: nstr,
        firmware: nstr,
        size_bytes: nnum,
        bus: nstr,
        kind: nstr,
        health: nstr,
        temperature_c: nnum,
        power_on_hours: nnum,
        wear_pct: nnum,
        read_errors: nnum,
        write_errors: nnum,
        removable: nbool,
        volumes: optional(arrayOf(str), []),
      }),
    ),
    [],
  ),
  processes: optional(
    arrayOf(
      obj({
        name: optional(str, ''),
        pid: optional(int, 0),
        memory_bytes: nnum,
        cpu_pct: nnum,
      }),
    ),
    [],
  ),
  process_count: nint,
  services: optional(
    arrayOf(
      obj({
        name: optional(str, ''),
        display: nstr,
        state: optional(str, ''),
        exit_code: nnum,
      }),
    ),
    [],
  ),
  service_count: nint,
  updates: optional(
    nullable(
      obj({
        checked_at: nstr,
        pending: optional(
          arrayOf(
            obj({
              title: optional(str, ''),
              id: nstr,
              size_bytes: nnum,
              severity: nstr,
              restart: nbool,
            }),
          ),
          [],
        ),
        installed: optional(arrayOf(obj({ title: optional(str, ''), at: nstr })), []),
        reboot_pending: nbool,
        error: nstr,
      }),
    ),
    null,
  ),
  errors: optional(arrayOf(str), []),
})

function telemetryOf(t: ReturnType<typeof telemetryShape>): NodeTelemetry {
  const load = t.cpu.load
  return {
    sampledAt: t.sampled_at,
    machine: {
      manufacturer: t.machine.manufacturer,
      model: t.machine.model,
      chip: t.machine.chip,
      biosVendor: t.machine.bios_vendor,
      biosVersion: t.machine.bios_version,
      biosDate: t.machine.bios_date,
      boardManufacturer: t.machine.board_manufacturer,
      boardProduct: t.machine.board_product,
      form: t.machine.form,
    },
    os: { kernel: t.os.kernel, build: t.os.build, installedAt: t.os.installed_at },
    cpu: {
      model: t.cpu.model,
      cores: t.cpu.cores,
      threads: t.cpu.threads,
      frequencyMhz: t.cpu.frequency_mhz,
      usagePct: t.cpu.usage_pct,
      load: load !== null && load.length === 3 ? [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] : null,
      temperatureC: t.cpu.temperature_c,
    },
    memory: {
      totalBytes: t.memory.total_bytes,
      usedBytes: t.memory.used_bytes,
      availableBytes: t.memory.available_bytes,
      cachedBytes: t.memory.cached_bytes,
      compressedBytes: t.memory.compressed_bytes,
      committedBytes: t.memory.committed_bytes,
      commitLimitBytes: t.memory.commit_limit_bytes,
      swapTotalBytes: t.memory.swap_total_bytes,
      swapUsedBytes: t.memory.swap_used_bytes,
      slots: t.memory.slots,
      maxCapacityBytes: t.memory.max_capacity_bytes,
      modules: t.memory.modules.map((m) => ({
        locator: m.locator,
        sizeBytes: m.size_bytes,
        speedMts: m.speed_mts,
        kind: m.kind,
        manufacturer: m.manufacturer,
        partNumber: m.part_number,
      })),
    },
    disks: t.disks.map((d) => ({
      mount: d.mount,
      name: d.name,
      fs: d.fs,
      totalBytes: d.total_bytes,
      usedBytes: d.used_bytes,
      freeBytes: d.free_bytes,
      kind: d.kind,
    })),
    gpus: t.gpus.map((g) => ({
      name: g.name,
      vendor: g.vendor,
      driver: g.driver,
      vramTotalBytes: g.vram_total_bytes,
      vramUsedBytes: g.vram_used_bytes,
      usagePct: g.usage_pct,
      temperatureC: g.temperature_c,
      powerW: g.power_w,
    })),
    temperatures: t.temperatures.map((x) => ({ label: x.label, celsius: x.celsius })),
    network: t.network.map((n) => ({
      interface: n.interface,
      rxBytes: n.rx_bytes,
      txBytes: n.tx_bytes,
      rxBps: n.rx_bps,
      txBps: n.tx_bps,
    })),
    battery:
      t.battery === null
        ? null
        : {
            percent: t.battery.percent,
            charging: t.battery.charging,
            healthPct: t.battery.health_pct,
          },
    drives: t.drives.map((d) => ({
      name: d.name,
      serial: d.serial,
      firmware: d.firmware,
      sizeBytes: d.size_bytes,
      bus: d.bus,
      kind: d.kind,
      health: d.health,
      temperatureC: d.temperature_c,
      powerOnHours: d.power_on_hours,
      wearPct: d.wear_pct,
      readErrors: d.read_errors,
      writeErrors: d.write_errors,
      removable: d.removable,
      volumes: d.volumes,
    })),
    processes: t.processes.map((p) => ({
      name: p.name,
      pid: p.pid,
      memoryBytes: p.memory_bytes,
      cpuPct: p.cpu_pct,
    })),
    processCount: t.process_count,
    services: t.services.map((s) => ({
      name: s.name,
      display: s.display,
      state: s.state,
      exitCode: s.exit_code,
    })),
    serviceCount: t.service_count,
    updates:
      t.updates === null
        ? null
        : {
            checkedAt: t.updates.checked_at,
            pending: t.updates.pending.map((u) => ({
              title: u.title,
              id: u.id,
              sizeBytes: u.size_bytes,
              severity: u.severity,
              restart: u.restart,
            })),
            installed: t.updates.installed.map((i) => ({ title: i.title, at: i.at })),
            rebootPending: t.updates.reboot_pending,
            error: t.updates.error,
          },
    errors: t.errors,
  }
}

/** The telemetry block of a status document, when the agent carries one (0.7.0+). */
export function nodeTelemetry(statusBody: unknown): NodeTelemetry | null {
  if (typeof statusBody !== 'object' || statusBody === null) return null
  const t = (statusBody as { telemetry?: unknown }).telemetry
  if (typeof t !== 'object' || t === null) return null
  return telemetryOf(decode(telemetryShape, t))
}

/**
 * The full telemetry document, as `GET /telemetry` answers it to the box's
 * token (agent 0.8.0+): the open page's block plus drive serials, the
 * heaviest processes, the services that are down and the OS's updates.
 */
export function nodeTelemetryFull(body: unknown): NodeTelemetry | null {
  if (typeof body !== 'object' || body === null) return null
  return telemetryOf(decode(telemetryShape, body))
}
