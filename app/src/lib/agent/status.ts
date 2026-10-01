import type {
  App,
  Battery,
  Browser,
  ClaudeState,
  CredentialStore,
  Disk,
  Drive,
  Gpu,
  InstallMethod,
  LinkStatus,
  Machine,
  MachineSettings,
  MemoryModule,
  Network,
  Policy,
  Report,
  SantreeDoor,
  Session,
  StatusDocument,
  Summary,
  Telemetry,
  TunnelStatus,
  Updates,
} from '../../host/controller/generated'
import {
  absent,
  arrayOf,
  bool,
  type Decoder,
  int,
  nbool,
  nint,
  nnum,
  nstr,
  nullable,
  num,
  obj,
  oneOf,
  reads,
  str,
  triple,
} from '../contract/decode'

// A machine's documents as the box reads them — its status document, its
// Claude report and summary, its telemetry — exactly as the agent writes
// them (agent/src/core/status.rs, claude/, telemetry/). Each decoder is held to
// the generated type both ways (`reads`), so the loaders take the generated
// types themselves; the controller hands these documents over in its
// answers (host/controller/wire.ts).

export const claudeState = oneOf<ClaudeState>({
  off: true,
  'not-installed': true,
  starting: true,
  running: true,
  waiting: true,
  stopped: true,
  'no-session': true,
  unknown: true,
})

export const summary = reads<Summary>()(
  obj({
    state: claudeState,
    detail: nstr,
    cli_version: nstr,
    server_version: nstr,
    sessions: int,
    started_at: nstr,
    signed_in: bool,
  }),
)

const session = reads<Session>()(
  obj({
    pid: int,
    transcript_id: nstr,
    remote_id: nstr,
    cwd: nstr,
    name: nstr,
    kind: nstr,
    entrypoint: nstr,
    version: nstr,
    started_at: nint,
    status: nstr,
    last_activity_at: nint,
    alive: bool,
  }),
)

const actionState = oneOf({ running: true, done: true, refused: true, failed: true })

export const report: Decoder<Report> = reads<Report>()(
  obj({
    path: nstr,
    install_method: nullable(
      oneOf<InstallMethod>({
        native: true,
        npm: true,
        homebrew: true,
        winget: true,
        path: true,
        unknown: true,
      }),
    ),
    cli_version: nstr,
    last_update: nullable(obj({ at: str, ok: bool, from: nstr, to: nstr, detail: str })),
    state: claudeState,
    detail: nstr,
    last_line: absent(str),
    pid: nint,
    started_at: nstr,
    restarts: int,
    last_exit: nstr,
    server: obj({ version: nstr, environment_id: nstr, spawn_mode: nstr, max_sessions: nint }),
    sessions: arrayOf(session),
    recovered: arrayOf(obj({ id: str, result: actionState, detail: str, at: str })),
    credentials: obj({
      present: bool,
      store: nullable(oneOf<CredentialStore>({ file: true, keychain: true, unknown: true })),
      subscription_type: nstr,
      rate_limit_tier: nstr,
      expires_at: nint,
      refresh_expires_at: nint,
      scopes: arrayOf(str),
    }),
    settings: obj({ model: nstr, effort_level: nstr }),
    user: nstr,
    home: nstr,
    workdir: nstr,
    workdir_via: nstr,
    log: nstr,
    job: nstr,
    reported_at: str,
  }),
)

const tunnel = reads<TunnelStatus>()(
  obj({
    endpoint: str,
    resolved: nstr,
    address: str,
    last_handshake_secs: nint,
    rx_bytes: num,
    tx_bytes: num,
    error: nstr,
  }),
)

const link = reads<LinkStatus>()(
  obj({
    address: nstr,
    found_via: nullable(oneOf({ config: true, dns: true, unknown: true })),
    state: nullable(
      oneOf({
        unpaired: true,
        connecting: true,
        pending: true,
        approved: true,
        revoked: true,
        refused: true,
        'key-changed': true,
        unknown: true,
      }),
    ),
    connected: bool,
    since: nstr,
    fingerprint: str,
    controller_fingerprint: nstr,
    rotated: nstr,
    error: nstr,
    tunnel: nullable(tunnel),
  }),
)

/** The box's policy as the machine holds it (link/wire.rs `Policy`). */
export const policy = reads<Policy>()(
  obj({
    awake_hold: bool,
    claude_remote_control: bool,
    claude_workdir: absent(nstr),
    providers: absent(obj({ lemonade: absent(nullable(obj({ port: absent(nint) }))) })),
    santree: absent(bool),
    session_host: absent(nullable(obj({ address: str, public_key: str }))),
  }),
)

const settingKey = oneOf({ awake_hold: true, claude_remote_control: true, santree: true })

const machineSettings = reads<MachineSettings>()(
  obj({
    node: nstr,
    fingerprint: nstr,
    fingerprint_short: nstr,
    linked: bool,
    awake_hold: bool,
    claude_remote_control: bool,
    santree: bool,
    pending: arrayOf(
      obj({ key: settingKey, want: bool, via: oneOf({ box: true, browser: true }) }),
    ),
    failed: arrayOf(obj({ key: settingKey, want: bool, why: str })),
    operator_uid: nint,
    operator: nstr,
    may_change: absent(bool),
  }),
)

const errorCode = oneOf({
  bad_request: true,
  version: true,
  unknown_method: true,
  unsupported: true,
  unavailable: true,
  busy: true,
  too_large: true,
  forbidden: true,
  revoked: true,
  internal: true,
  not_found: true,
  santree_off: true,
  host_key_changed: true,
  unknown: true,
})

const santreeDoor = reads<SantreeDoor>()(
  obj({
    open: int,
    max: int,
    last_refused: nullable(obj({ at: str, code: errorCode })),
  }),
)

/** The status document (shared.rs `StatusDocument`). */
export const statusDocument = reads<StatusDocument>()(
  obj({
    agent: str,
    version: str,
    hostname: str,
    os: str,
    os_name: str,
    os_version: str,
    arch: str,
    cpu: str,
    memory_bytes: nint,
    uptime_secs: int,
    os_uptime_secs: nint,
    booted_at: nstr,
    awake_hold: bool,
    hold_error: nstr,
    power_requests: nstr,
    update_available: nstr,
    restart_pending: bool,
    policy,
    claude: nullable(summary),
    tray: obj({ reporting: bool, last_report: nstr }),
    claude_update_requested: bool,
    claude_restart_requested: bool,
    settings: machineSettings,
    santree: nullable(santreeDoor),
    controller: nullable(link),
    last_update_check: nstr,
    last_update_result: nstr,
    updated_from: nstr,
    updated_at: nstr,
    probation: nullable(obj({ version: str, from: str, starts: int, installed_at: str })),
    rolled_back: nullable(obj({ version: str, to: str, starts: int, at: str })),
  }),
)

// ── telemetry ───────────────────────────────────────────────────────────────
//
// What the machine is and how it is doing, sampled by the agent every 15 s
// (agent/src/telemetry/). Every field the agent could not read is null or an
// empty list, and `errors` says why, so a page draws a reason rather than a
// dash.

const machine = reads<Machine>()(
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
    target: nstr,
  }),
)

const memoryModule = reads<MemoryModule>()(
  obj({
    locator: nstr,
    size_bytes: nnum,
    speed_mts: nnum,
    kind: nstr,
    manufacturer: nstr,
    part_number: nstr,
  }),
)

const disk = reads<Disk>()(
  obj({
    mount: str,
    name: nstr,
    fs: nstr,
    total_bytes: nnum,
    used_bytes: nnum,
    free_bytes: nnum,
    kind: nstr,
  }),
)

const drive = reads<Drive>()(
  obj({
    name: str,
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
    volumes: arrayOf(str),
  }),
)

const gpu = reads<Gpu>()(
  obj({
    name: str,
    vendor: nstr,
    driver: nstr,
    driver_brand: nstr,
    driver_date: nstr,
    vram_total_bytes: nnum,
    vram_used_bytes: nnum,
    usage_pct: nnum,
    temperature_c: nnum,
    power_w: nnum,
  }),
)

const network = reads<Network>()(
  obj({ interface: str, rx_bytes: nnum, tx_bytes: nnum, rx_bps: nnum, tx_bps: nnum }),
)

const battery = reads<Battery>()(
  obj({ percent: nnum, charging: nbool, health_pct: nnum, cycles: nnum, condition: nstr }),
)

const browser = reads<Browser>()(
  obj({
    name: str,
    kind: str,
    version: nstr,
    channel: nstr,
    path: nstr,
    running: bool,
    default_browser: bool,
  }),
)

const updates = reads<Updates>()(
  obj({
    checked_at: nstr,
    pending: arrayOf(
      obj({ title: str, id: nstr, size_bytes: nnum, severity: nstr, restart: nbool }),
    ),
    installed: arrayOf(obj({ title: str, at: nstr })),
    reboot_pending: nbool,
    error: nstr,
  }),
)

const app = reads<App>()(
  obj({
    name: str,
    version: nstr,
    publisher: nstr,
    installed_at: nstr,
    size_bytes: nnum,
    kind: str,
    source: nstr,
    path: nstr,
  }),
)

/**
 * A telemetry document: the full one (`nodes.get` with `full`, the
 * controller's own `telemetry.get`) with drive serials, the heaviest
 * processes, the services that are down and the OS's updates, or the open one
 * without them.
 */
export const telemetry = reads<Telemetry>()(
  obj({
    sampled_at: str,
    machine,
    os: obj({ kernel: nstr, build: nstr, installed_at: nstr }),
    cpu: obj({
      model: nstr,
      cores: nint,
      threads: nint,
      frequency_mhz: nnum,
      usage_pct: nnum,
      load: nullable(triple),
      temperature_c: nnum,
    }),
    memory: obj({
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
      modules: arrayOf(memoryModule),
    }),
    disks: arrayOf(disk),
    drives: arrayOf(drive),
    gpus: arrayOf(gpu),
    temperatures: arrayOf(obj({ label: str, celsius: num })),
    network: arrayOf(network),
    battery: nullable(battery),
    processes: arrayOf(obj({ name: str, pid: int, memory_bytes: nnum, cpu_pct: nnum })),
    process_count: nint,
    services: arrayOf(obj({ name: str, display: nstr, state: str, exit_code: nint })),
    service_count: nint,
    browsers: arrayOf(browser),
    apps: arrayOf(app),
    app_count: nint,
    updates: nullable(updates),
    errors: arrayOf(str),
  }),
)
