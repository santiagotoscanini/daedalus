import { relations } from 'drizzle-orm'
import {
  boolean,
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
// What it deliberately does NOT store: secret VALUES. `operatorSecrets` is a
// boolean saying "this app has a tracked <name>-env.sops at the stack root".
// The ciphertext stays in sops, in git, decrypted at activation — never in
// Postgres, never in a page render.

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

    // Whether a tracked <name>-env.sops exists at stacks/apps/. Not the
    // contents — see the header.
    operatorSecrets: boolean('operator_secrets').notNull().default(false),

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
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default('mdi-cube-outline-#94a3b8'),

    // Free-form rationale keyed by area: app, auth, storage, egress, stage,
    // secrets. jsonb rather than columns because the set of things worth
    // explaining is open-ended and none of it is queried.
    notes: jsonb('notes').$type<Record<string, string>>().notNull().default({}),

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
// the sops env file (see apps.operatorSecrets).
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

export const appsRelations = relations(apps, ({ many }) => ({
  envVars: many(appEnvVars),
  deployments: many(deployments),
}))

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  app: one(apps, { fields: [deployments.appId], references: [apps.id] }),
}))

export const appEnvVarsRelations = relations(appEnvVars, ({ one }) => ({
  app: one(apps, { fields: [appEnvVars.appId], references: [apps.id] }),
}))

export type App = typeof apps.$inferSelect
export type AppEnvVar = typeof appEnvVars.$inferSelect
export type Deployment = typeof deployments.$inferSelect
