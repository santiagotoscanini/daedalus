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

// The app registry — daedalus's authoritative copy of what stacks/apps
// declares. It mirrors the `fleet.apps` submodule (stacks/apps/apps.nix)
// field for field, because the Apply flow has to be able to round-trip it
// back out to stacks/apps/apps.json without losing anything.
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

    // "registry" (CI builds, zot hosts, deploy timer pulls) or "local"
    // (source in the flake repo, bind-mounted, dev server). See the
    // `source.mode` option in stacks/apps/apps.nix.
    sourceMode: text('source_mode').notNull().default('registry'),

    // null = the platform default, registry.toscanini.me/<name>:latest.
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
    // problem. lib/app-icon.ts reads it from the app.
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

    // 'main' in v1; pull-request lanes come later, with prNumber set.
    lane: text('lane').notNull().default('main'),
    prNumber: integer('pr_number'),
    sha: text('sha').notNull(),

    // As requested: "auto" | "railpack" | "dockerfile". The host resolves
    // "auto"; what it chose lands in resolvedStrategy.
    strategy: text('strategy').notNull(),
    resolvedStrategy: text('resolved_strategy'),
    // "live" | "candidate", copied from the app at request time.
    publish: text('publish').notNull().default('live'),

    requestedBy: text('requested_by').notNull(),
    actor: text('actor'),
    // X-GitHub-Delivery of the push that asked. Not unique: operator and sweep
    // builds have none, and the replay guard is github_deliveries' primary
    // key, not this.
    deliveryId: text('delivery_id'),

    // queued → cloning → detecting → checking → building → publishing →
    // succeeded | failed | cancelled | superseded.
    state: text('state').notNull().default('queued'),
    phase: text('phase'),
    error: text('error'),
    // When the request was handed to the host; null while queued. The hard cap
    // counts from here — from createdAt, a build that waited behind another
    // would time out the moment it started. updatedAt is the last word heard
    // from the host, which is what the staleness check reads.
    startedAt: timestamp('started_at', { withTimezone: true }),

    // Shapes are owned by the status decoder in lib/builds.ts, not here.
    detected: jsonb('detected'),
    warnings: jsonb('warnings'),
    checks: jsonb('checks'),
    timings: jsonb('timings'),

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
// names, and are not: `lib/db.ts` does `import * as schema` and hands the whole
// module to drizzle, which is what makes the relational query API work — the
// `with: { envVars: … }` in lib/repo/apps.ts is these. Deleting them as dead
// code compiles cleanly and breaks every app page at runtime.
export const appsRelations = relations(apps, ({ many }) => ({
  envVars: many(appEnvVars),
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

export type App = typeof apps.$inferSelect
export type AppEnvVar = typeof appEnvVars.$inferSelect
export type Deployment = typeof deployments.$inferSelect

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

export type Setting = typeof settings.$inferSelect
