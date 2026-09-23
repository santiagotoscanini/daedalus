import { relations, sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
// TYPE-ONLY, all five, and they have to stay that way: `import type` is erased
// whole (verbatimModuleSyntax), so naming the build vocabulary here costs the
// schema no import edge at all — see host/boundary.test.ts on why the
// one-keyword difference between this and `import { type X }` matters.
import type { DetectionWarning } from '../lib/build-detect'
import type { BuildFacts } from '../lib/build-facts'
import type { BuildLane } from '../lib/build-queue'
import type {
  BuildChecks,
  BuildPublish,
  BuildRequester,
  BuildState,
  BuildStrategy,
} from '../lib/builds'
import type { McpScope } from '../lib/mcp'
import type { ModelPolicies } from '../lib/providers/policy'

// The app registry — daedalus's authoritative copy of what stacks/apps
// declares. It mirrors the `fleet.apps` submodule (stacks/apps/apps.nix)
// field for field, because the Apply flow has to be able to round-trip it
// back out to site/apps.json without losing anything.
//
// Two things this stores that Nix could not:
//
//   `notes`  — the *why* behind each setting. In declarations.nix these were
//              nix comments, which would have evaporated in the round-trip
//              through a database. They are first-class here and rendered
//              next to the setting they explain, which is strictly better
//              than a comment nobody reads.
//   ordering + timestamps — so the UI can show what changed and when.
//
// What it deliberately does NOT store: secret VALUES, and not whether an app
// HAS operator secrets either. That one is decided by a tracked
// <name>-env.sops existing at stacks/apps/, so a column here could only ever
// agree or disagree with the filesystem — and the disagreements were the whole
// problem. It arrives from the Nix manifest as a fact instead. The ciphertext
// stays in sops, in git, decrypted at activation — never in Postgres, never in
// a page render.

export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The fleet.apps key. Drives hostname, container name, postgres role and
    // database, and the GitHub repo — so it is the one field that can never
    // change without a migration of everything downstream.
    name: text('name').notNull(),

    // "lab" = LAN-only; "live" = also published through the Cloudflare tunnel.
    stage: text('stage').notNull().default('lab'),

    // True for apps declared by hand in Nix rather than managed here —
    // currently only daedalus itself. Shown read-only in the UI: an Apply that
    // broke daedalus's own entry would take down the interface you would use
    // to undo it, so that entry stays in stacks/daedalus/daedalus.nix.
    managedInNix: boolean('managed_in_nix').notNull().default(false),

    // "registry" (the box builds the image, zot hosts it, the deploy timer
    // pulls it) or "local" (source in the flake repo, bind-mounted, dev
    // server). See the `source.mode` option in stacks/apps/apps.nix.
    sourceMode: text('source_mode').notNull().default('registry'),

    // null = the platform default, <registryHost>/<name>:latest.
    // A value here is an override: a fork, a placeholder, or a pinned digest.
    image: text('image'),

    // null = the platform default, <name>.<baseDomain>. Constrained to one
    // label under the base domain — the traefik wildcard cert matches exactly
    // one, so a deeper name serves the wrong certificate. Enforced in the UI,
    // and again by an assertion in stacks/apps/apps.nix that fails the build.
    hostname: text('hostname'),

    postgres: boolean('postgres').notNull().default(false),
    storage: boolean('storage').notNull().default(false),
    litellm: boolean('litellm').notNull().default(false),
    prometheus: boolean('prometheus').notNull().default(false),

    // The freeze switch (registry schema v2, `deploy.enable`): OFF stops the
    // 2-minute deploy timer AND removes the app from the host trigger's
    // allowlist, so a freeze holds against the Redeploy button too. Pair with
    // a digest-pinned image override to hold a known-good build. Inert for
    // sourceMode "local" — there is no registry image to poll.
    deployEnable: boolean('deploy_enable').notNull().default(true),

    // "none" | "proxy" (traefik forward-auth) | "native" (the app is the
    // OIDC client). See AUTH.md for the order of preference.
    authMode: text('auth_mode').notNull().default('none'),
    // Unauthenticated path proving the app itself serves. Mandatory under
    // "proxy": it is the gatus probe, the forward-auth bypass and the deploy
    // health check all at once.
    authHealthPath: text('auth_health_path'),
    // Private iso-<name>-net whose only other member is traefik.
    authIsolated: boolean('auth_isolated').notNull().default(false),
    // Pocket ID groups allowed at the IdP. null = the platform default
    // (["admins"]); [] would mean any account with a passkey.
    authAllowedGroups: text('auth_allowed_groups').array(),
    authBypassRule: text('auth_bypass_rule'),

    // VPN egress: borrow a gluetun container's netns for all traffic. Both
    // columns move together — see the assertion in stacks/apps/apps.nix.
    egressContainer: text('egress_container'),
    egressHostPort: integer('egress_host_port'),

    // cgroup v2 caps; null = uncapped, the platform default. Three columns
    // rather than a jsonb blob because all three are edited, drift-compared
    // and rendered individually — the reasons `notes` is jsonb do not apply.
    //
    // cpus is `real`: fractional cores are the common case (0.5, 1.5) and the
    // value goes straight into cpu.max as a bandwidth quota.
    limitCpus: real('limit_cpus'),
    limitMemoryMb: integer('limit_memory_mb'),
    limitPids: integer('limit_pids'),

    // How the app is named to a person: its row in the list, its detail
    // page, and its entry on the Pocket ID consent screen.
    //
    // There is no icon column to go with it. Every app already publishes its
    // own icon — it is what the browser tab shows — so a column here could
    // only agree or disagree with that, and the disagreements were the whole
    // problem. host/app-icon.ts reads it from the app.
    description: text('description').notNull().default(''),

    // Free-form rationale keyed by area: app, auth, storage, egress, stage,
    // secrets. jsonb rather than columns because the set of things worth
    // explaining is open-ended and none of it is queried.
    notes: jsonb('notes').$type<Record<string, string>>().notNull().default({}),

    // Engine-only: how the box's own builder treats this app. Nix never reads
    // these, so toRegistryExport and driftOf leave them out — an edit here
    // ships nothing and must not light the Apply bar (apps.test.ts asserts it).
    //
    // GitHub's numeric repository id, filled by the build scheduler. A push is
    // matched on it rather than on the name, which a rename or transfer moves.
    githubRepoId: bigint('github_repo_id', { mode: 'number' }),
    // "auto" | "railpack" | "dockerfile" — what each build is asked to use.
    buildStrategy: text('build_strategy').notNull().default('auto'),
    // "live" | "candidate" — a candidate is pushed but never deployed.
    buildPublish: text('build_publish').notNull().default('live'),
    // Build-time env names the app needs set but not real, name → placeholder
    // value. Never secrets: they reach the build in the clear.
    buildEnvPlaceholders: jsonb('build_env_placeholders')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Env handed to Railpack — its RAILPACK_* switches, such as
    // RAILPACK_NODE_PLAYWRIGHT_INSTALL.
    railpackEnv: jsonb('railpack_env').$type<Record<string, string>>().notNull().default({}),
    // Whether pushes to this app's repo build on the box. Off by default: the
    // GitHub App is installed on every repository, and a repo moves to box
    // builds one at a time (plan step 7) by turning this on.
    buildOnBox: boolean('build_on_box').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('apps_name_idx').on(t.name)],
)

// Static env vars merged into the container's `environment`. A table rather
// than a jsonb blob on `apps` because each one carries a `note` that the UI
// shows inline, and because ordering is stable and editable.
//
// NOT for secrets — these end up in /nix/store, world-readable. Secrets ride
// the stack's sops env file (stacks/apps/<name>-env.sops).
export const appEnvVars = pgTable(
  'app_env_vars',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    note: text('note'),
    // Preserves the author's ordering across an export/import round-trip;
    // nix turns the list into an attrset and would otherwise sort it.
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('app_env_vars_app_key_idx').on(t.appId, t.key)],
)

// Scheduled work an app wants run on a clock: one systemd timer + service pair
// per row (`app-<app>-task-<taskId>`), generated by stacks/apps from the
// exported registry.
//
// A child table for the same two reasons appEnvVars is one. Each row is edited
// on its own and carries its own fields, and the ORDER is authored — nix turns
// the exported list into an attrset, which has no order at all, so `position`
// is what survives an export/import round trip and keeps a re-sync from
// reshuffling the list.
//
// `taskId` rather than `id`, because `id` here is the row's uuid and the
// task's id is a different thing entirely: the contract's
// `^[a-z0-9][a-z0-9-]{0,39}$` label that becomes part of a unit name ROOT
// starts. That charset is a security control — enforced in lib/tasks.ts — not
// a tidiness preference.
//
// `command` is argv, never a shell string: the generated unit runs
// `podman exec app-<name> <argv>` with no shell in between, so there is no
// quoting and no word splitting for a value to escape out of.
export const appTasks = pgTable(
  'app_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    /** A concrete systemd OnCalendar string — never a bare `hourly`/`daily`. */
    schedule: text('schedule').notNull(),
    command: jsonb('command').$type<string[]>().notNull(),
    timeoutSec: integer('timeout_sec').notNull().default(900),
    position: integer('position').notNull().default(0),
  },
  (t) => [uniqueIndex('app_tasks_app_task_idx').on(t.appId, t.taskId)],
)

// Deploy history.
//
// The platform's own state file (/var/lib/app-deploy/<name>) holds only the
// LATEST result, overwritten every run — so on its own there is no history at
// all. stacks/apps/assets/deploy.sh therefore appends one JSON line per real
// deploy to a sibling .log, and daedalus ingests those lines here.
//
// Recorded by deploy.sh rather than by daedalus because most deploys never
// touch daedalus: the 2-minute timer and a manual `systemctl start` both land
// in that script. Recording at the one place that always runs is what makes
// this history complete rather than "the deploys daedalus happened to trigger".
//
// `revision` and friends are resolved from the image's OCI labels at ingest
// time and STORED, not looked up on render: zot's retention will eventually
// GC an old manifest, and the history should outlive the image it describes.
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),

    digest: text('digest').notNull(),
    previousDigest: text('previous_digest'),

    // "ok" | "failed" — deploy.sh's own verdict, from a real health check
    // through traefik rather than from `systemctl` having returned 0.
    result: text('result').notNull(),
    httpCode: text('http_code'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull().default(0),

    // From the image config's OCI labels, when the manifest is still in the
    // registry at ingest time.
    revision: text('revision'), // org.opencontainers.image.revision (git sha)
    sourceUrl: text('source_url'), // org.opencontainers.image.source
    imageCreatedAt: timestamp('image_created_at', { withTimezone: true }),
  },
  // A deploy is identified by which image landed and when it started. Makes
  // ingest idempotent: the journal is re-read on every page load and the same
  // line must not become a second row.
  (t) => [uniqueIndex('deployments_app_digest_started_idx').on(t.appId, t.digest, t.startedAt)],
)

// Builds run by the box's own builder (BuildKit + Railpack, driven by the
// GitHub App). One row per build; the host's status file is the live truth
// while one runs, and the scheduler folds it in here so the history outlives
// the host's logs.
//
// `builds_one_queued_per_lane` is what supersede leans on: at most one queued
// row per app and lane, so a newer push marks the queued row `superseded` and
// inserts its own, in one transaction (lib/repo/builds.ts), instead of stacking
// a build of a sha that is already stale. The 'queued' literal is written inside the template
// on purpose — an interpolated value becomes a bound parameter, which
// drizzle-kit cannot put into CREATE INDEX.
export const builds = pgTable(
  'builds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),

    // Eleven columns below carry `.$type<>()`. Postgres knows these as text and
    // jsonb and would take any string or any document; every one of them in
    // fact holds a member of a union lib/builds.ts owns. Recording that here
    // rather than at the reader is the same trust either way — this module is
    // written by lib/repo/builds.ts alone — but it puts the narrowing where the
    // next reader looks first, and it makes a column whose vocabulary changes
    // an error at every use instead of a cast that keeps compiling.
    //
    // What it does NOT buy: a row written before a union member was renamed
    // still reads back as a confident, wrong `BuildState`. Nothing in the type
    // system reaches rows already in the table — which is exactly why the
    // partition over BUILD_STATES is asserted in lib/build-states.test.ts.

    // 'main' in v1; pull-request lanes come later, with prNumber set.
    lane: text('lane').$type<BuildLane>().notNull().default('main'),
    prNumber: integer('pr_number'),
    sha: text('sha').notNull(),

    // As requested: "auto" | "railpack" | "dockerfile". The host resolves
    // "auto"; what it chose lands in resolvedStrategy.
    strategy: text('strategy').$type<BuildStrategy>().notNull(),
    resolvedStrategy: text('resolved_strategy').$type<Exclude<BuildStrategy, 'auto'>>(),
    // "live" | "candidate", copied from the app at request time.
    publish: text('publish').$type<BuildPublish>().notNull().default('live'),

    requestedBy: text('requested_by').$type<BuildRequester>().notNull(),
    actor: text('actor'),
    // X-GitHub-Delivery of the push that asked. Not unique: operator and sweep
    // builds have none, and the replay guard is github_deliveries' primary
    // key, not this.
    deliveryId: text('delivery_id'),

    // queued → cloning → detecting → checking → building → publishing →
    // succeeded | failed | cancelled | superseded.
    state: text('state').$type<BuildState>().notNull().default('queued'),
    phase: text('phase'),
    error: text('error'),
    // When the request was handed to the host; null while queued. The hard cap
    // counts from here — from createdAt, a build that waited behind another
    // would time out the moment it started. updatedAt is the last word heard
    // from the host, which is what the staleness check reads.
    startedAt: timestamp('started_at', { withTimezone: true }),

    // Shapes are owned by the status decoder in lib/builds.ts, not here — so
    // this one stays `unknown`, which is what bare jsonb already infers and
    // what BuildRow.detected declares. Readers decode it (detectionFromStatus)
    // rather than trusting it, which is how a Railpack field the engine learns
    // to read later is there in old rows too.
    detected: jsonb('detected'),
    // NULL and [] mean different things here and the difference is load-bearing:
    // NULL is "nobody computed warnings for this build" — a Dockerfile build, a
    // failure before `railpack prepare`, or a row from before the engine
    // computed them at all — while [] is "computed, and there was nothing to
    // say". The build page shows which rather than calling every silence clean.
    warnings: jsonb('warnings').$type<DetectionWarning[]>(),
    checks: jsonb('checks').$type<BuildChecks>(),
    /** Milliseconds per phase, keyed by phase name. */
    timings: jsonb('timings').$type<Record<string, number>>(),
    // The agent's `image` and `build` status keys, decoded (lib/build-facts.ts:
    // the pushed tags, the layer count and compressed sizes, the media type;
    // the runner, the secrets fingerprint, what the cache did). ONE jsonb rather
    // than five columns because none of it is ever queried, compared or indexed
    // — it is read back whole, for one page and one check run — and because the
    // host agent grows keys faster than a migration per key would be worth.
    // digest and size_bytes stay their own columns: those two ARE matched
    // against deploy rows and summed.
    facts: jsonb('facts').$type<BuildFacts>(),

    // GitHub's ids for what this build posted. Numbers, not bigint: both are
    // far below 2^53, and a bigint would not survive the server-function wire.
    checkRunId: bigint('check_run_id', { mode: 'number' }),
    deploymentId: bigint('deployment_id', { mode: 'number' }),
    // The final state has been sent to GitHub.
    reported: boolean('reported').notNull().default(false),

    digest: text('digest'),
    imageRef: text('image_ref'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('builds_app_created_idx').on(t.appId, t.createdAt),
    uniqueIndex('builds_one_queued_per_lane').on(t.appId, t.lane).where(sql`${t.state} = 'queued'`),
  ],
)

// Every X-GitHub-Delivery the webhook has accepted, pruned after 7 days. The
// primary key IS the replay guard: GitHub's redelivery reuses the id, so
// inserting it in the same transaction as the enqueue turns a replayed push
// into a no-op instead of a second build.
export const githubDeliveries = pgTable('github_deliveries', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  action: text('action'),
  // What the route did with it.
  outcome: text('outcome').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

// The `relations` blocks below look unreferenced to any search for their
// names, and are not: `host/db.ts` does `import * as schema` and hands the whole
// module to drizzle, which is what makes the relational query API work — the
// `with: { envVars: … }` in lib/repo/apps.ts is these. Deleting them as dead
// code compiles cleanly and breaks every app page at runtime.
export const appsRelations = relations(apps, ({ many }) => ({
  envVars: many(appEnvVars),
  tasks: many(appTasks),
  deployments: many(deployments),
  builds: many(builds),
}))

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  app: one(apps, { fields: [deployments.appId], references: [apps.id] }),
}))

export const buildsRelations = relations(builds, ({ one }) => ({
  app: one(apps, { fields: [builds.appId], references: [apps.id] }),
}))

export const appEnvVarsRelations = relations(appEnvVars, ({ one }) => ({
  app: one(apps, { fields: [appEnvVars.appId], references: [apps.id] }),
}))

export const appTasksRelations = relations(appTasks, ({ one }) => ({
  app: one(apps, { fields: [appTasks.appId], references: [apps.id] }),
}))

// Operator preferences that the NixOS side does not consume.
//
// The dividing line matters and is the whole reason this table exists.
// Anything nix reads — the domain, the network, which modules are on, the app
// registry — belongs in the site repo, where a change is a commit and a
// rebuild. Anything nix does NOT read — the theme, UI preferences, onboarding
// progress — belongs here, where a change is an UPDATE and nothing rebuilds.
// Putting the theme in the site repo would mean a NixOS generation per colour
// swap; putting the domain here would mean a setting the system never obeys.
//
// Deliberately a key/value table rather than one column per preference: these
// are read individually by name, never queried across, and a new preference
// should not be a migration. The value is jsonb so a preference can be an
// object (a theme preset is one) without a second encoding to get wrong.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Tokens that let a machine call the MCP server at /mcp.
//
// The one door into this box that no person opens. Everything else the app
// serves is behind the Pocket ID gate, which authenticates a human with a
// passkey; an agent cannot hold one, exactly as zot cannot (see
// routes/api.deploy.ts). So /mcp carries its own credential, and this is where
// the credential lives.
//
// WHAT IS STORED IS A HASH, never the token. The value is shown once, at mint,
// and is then unrecoverable — a leaked database row cannot be replayed as a
// token, and "reveal it again" is not a feature this table can grow. SHA-256
// rather than argon2 on purpose: the secret is 32 bytes from `randomBytes`, so
// there is no dictionary to slow down, and the lookup has to be a single
// indexed read on every call.
//
// `scope` is lib/mcp.ts's, and it is the whole authorization model: `read`
// reaches the loaders, `write` reaches those plus the five mutations. `label`
// is not decoration — it becomes the ACTOR of every write the token makes, so
// a commit, a build row and a journal line say "mcp:triage" rather than
// "unknown operator". Name a token after who holds it.
//
// `revokedAt` rather than a delete, so a revoked token's label still explains
// the records it left behind. `lastUsedAt` is the only thing a call writes,
// and it is what makes an unused token visible enough to revoke.
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    scope: text('scope').$type<McpScope>().notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  // Unique, and the lookup index: a call hashes what it was given and selects
  // on this column exactly once.
  (t) => [uniqueIndex('mcp_tokens_hash_idx').on(t.tokenHash)],
)

// The break-glass local admins (core/local-login.ts).
//
// Dormant by construction: nothing reads or writes this table unless
// site.json's `auth.localLogin` is true, and on a box behind Pocket ID it is
// absent. When it is on, one row is one operator who can sign in with a
// password instead of a passkey — the way back into the control plane when
// the IdP is down, and the first door on a fresh install before an IdP
// exists. A local admin is implicitly in `admins`.
//
// `passwordHash` is argon2id (the PHC string, parameters included), which is
// the one place in this schema a real password hash is warranted: unlike an
// MCP token the value WAS chosen by a person, so there is a dictionary to slow
// down. `username` is the actor every write is recorded under, namespaced as
// `local:<username>` so a record says which door it came through.
export const localAdmins = pgTable('local_admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
})

// The other machines, once they have said hello (core/nodes.ts).
//
// A row is a machine's KEY, not its address: the agent generates an ed25519
// keypair at install and signs every hello with it, and `id` is the first
// sixteen hex characters of the public key's SHA-256. Hostnames change and
// leases move; the key is what the box trusts, and `state` is what the box
// has decided about it. `pending` is a machine that announced itself and
// has not been approved; `approved` is a node the box may act on;
// `revoked` is a key the box will no longer listen to, kept rather than
// deleted so its history still explains itself.
//
// `lastHello` is the whole last payload, as the agent sent it, so a field
// the agent adds later is visible here before anything reads it by name.
export type NodeState = 'pending' | 'approved' | 'revoked'

export const nodes = pgTable('nodes', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull().unique(),
  state: text('state').$type<NodeState>().notNull().default('pending'),
  hostname: text('hostname').notNull(),
  os: text('os').notNull(),
  arch: text('arch').notNull(),
  agentVersion: text('agent_version').notNull(),
  mac: text('mac'),
  lanIp: text('lan_ip'),
  statusPort: integer('status_port'),
  lastHello: jsonb('last_hello').$type<Record<string, unknown>>().notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedBy: text('approved_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /// The two instructions the box can send a node: "check for updates now"
  /// and "restart Claude remote control". Set by an admin, carried by the
  /// next hello's answer, cleared as they go out.
  updateCheckRequested: boolean('update_check_requested').notNull().default(false),
  claudeRestartRequested: boolean('claude_restart_requested').notNull().default(false),
  /// What the box wants of this machine, set on Settings › Machines and
  /// carried by every hello's answer once the node is approved. A JSON
  /// object rather than columns because it is the agent's vocabulary
  /// (agent/src/hello.rs `Policy`) and grows with the agent; absent keys
  /// mean the agent's own defaults. Postgres, not site/: nothing nix
  /// builds reads it, so changing it is an UPDATE and nothing rebuilds.
  policy: jsonb('policy').$type<NodePolicy>().notNull().default({}),
  /// The secret the box presents to the agent to read its full Claude
  /// report (`GET /claude` on the status page). Minted at approval, handed
  /// down every hello answer over HTTPS, cleared on revoke. Never leaves
  /// the server: NodeRow does not carry it.
  token: text('token'),
})

/**
 * The per-node policy. Every key optional: the agent's defaults stand for
 * a key that is not set, and the page shows those defaults as the value.
 */
export type NodePolicy = {
  /** What the pages call the machine instead of its hostname. */
  displayName?: string
  /**
   * What the machine is called ON THE NETWORK: a DNS label
   * (lib/nodes-file.ts NODE_NAME_RE), unique among approved nodes. Unset,
   * the hostname slugified. pi-hole gives the lease this name (the box
   * writes the dnsmasq line, host/node-targets.ts), and nix reads it from
   * site/nodes.json.
   */
  name?: string
  /**
   * Add the machine's current address to its dnsmasq line, so the pool
   * keeps handing it that address. Off, the name follows whatever lease
   * the machine gets. No page sets this yet.
   */
  pinAddress?: boolean
  /**
   * The providers this machine offers and on which port. `offer` false
   * keeps the provider out of site/nodes.json (nothing on the box dials
   * it) without forgetting the port. The agent hears the port, never
   * `offer` nor `models` — the per-model curation (alias, offered, mode;
   * lib/providers/policy.ts) is the gateway sync's to read.
   */
  providers?: { lemonade?: { port: number; offer: boolean; models?: ModelPolicies } }
  /** Hold the machine awake. The agent's default is true. */
  awakeHold?: boolean
  /** Run `claude remote-control` in the user's session. The agent's default is true. */
  claudeRemoteControl?: boolean
  /** The directory the server runs in. Unset, the tray picks the most recently used trusted project. */
  claudeWorkdir?: string
  /**
   * The parts nothing in the machine reports — case, cooler, power supply —
   * chosen from lib/hardware/catalog.ts by id. Only the pages read these;
   * the agent never hears them.
   */
  hardware?: { case?: string; cooler?: string; psu?: string; finish?: string }
}
