import { ENGINE_REPO } from '../../lib/engine'
import type { BoxSettings } from '../settings/types'

// Renders the site directory's files — the exact bytes that land in it.
//
// The same division of labour as lib/registry-file.ts, for the same reason:
// the host agent copies bytes and stages them, and every decision about
// SHAPE is application logic, where it can be typed and tested. site-write.sh
// never builds JSON.
//
// What this file is: the box's own description of itself, in the one format
// that is not code. Today it is written FROM what nix already says (the
// /export domains and the env binds daedalus.nix makes) — a faithful copy that
// nothing reads yet. It has to be provably identical to what the system is
// built from before anything is allowed to build from it instead (Phase 5).
//
// Formatting is load-bearing, like the registry's: two spaces, trailing
// newline, keys in a stable order, so that changing one setting later
// produces a one-line diff in a repository a human reads.

const PREAMBLE = {
  _generated:
    'Managed by daedalus. Written from the box’s running configuration by Settings › Site. Hand edits are kept — daedalus only rewrites this file when you ask it to — but anything it does rewrite comes from the UI.',
  _why: 'Configuration that is data, not code: what THIS box is, separated from the engine that builds it. Nix reads this directory as part of the flake, so a change here is a commit and a rebuild, and the repository stays the whole account of how the machine got the way it is.',
}

/** The GitHub App this box created. Identifiers only: its private key, webhook
    secret and client secret are sealed in the vault, never in this file. */
export type SiteGithubApp = {
  id: number
  slug: string
  clientId: string
  htmlUrl: string
  owner: string
  ownerId: number
}

export type SiteDocument = {
  schemaVersion: 1
  identity: {
    hostname: string
    baseDomain: string
    /** The control plane answers at `https://<controlPlane>.<baseDomain>`. '' = not written yet. */
    controlPlane: string
    /** The label before a rename, served beside the new one until it is confirmed. */
    controlPlanePrevious: string | null
    timezone: string
    /** The GitHub account the app repos live under. */
    owner: string
    operator: { user: string; group: string }
  }
  network: {
    lanIp: string
    interface: string | null
    gateway: string | null
    wanHost: string
    ddns: { host: string; interval: string }
    dhcp: { active: boolean; router: string; start: string; end: string; leaseTime: string }
    dnsUpstreams: string[]
  }
  mail: { sender: string; alertTo: string }
  /** Identifiers, not credentials — the ids in every dash.cloudflare.com URL.
      The tokens stay in the secret tree; this repo gains a vault in Phase 6. */
  cloudflare: { accountId: string; zoneId: string; tunnelId: string }
  /** Absent means no App, the same as `app: null`. No settings tab edits it:
      it is carried from the committed document, and only the App-creation
      callback writes a new one. */
  github?: { app: SiteGithubApp | null }
  /**
   * The break-glass local login (core/local-login.ts). Absent means off, and
   * off means the login route does not exist. Deliberately NOT in core/site's
   * EDITABLE list: a password door into the control plane is turned on by
   * the onboarding wizard on a fresh install, or by a hand edit and a commit
   * — never from the UI the door leads into, where a compromised session
   * could open it for itself. Nix does not read it today.
   */
  auth?: { localLogin: boolean }
  /**
   * How this box is developed on, as opposed to run. `engineOverride` is an
   * absolute path to an engine clone on the box, or null: while set, every
   * Apply builds against THAT tree (`--override-input daedalus path:<clone>`,
   * lock untouched) and activates it with `nixos-rebuild test` — never
   * `switch` — and the image and engine updaters refuse to run, because a
   * pin moved under an override would name a rev nothing is running. Nix does
   * not read it; the host agents do (host/lib.sh `engine_override`). Absent
   * and `{ engineOverride: null }` are the same document, and the renderer
   * drops the block while it holds that.
   */
  developer: { engineOverride: string | null }
  /**
   * Which configured git identity the box's own commits are made as: every
   * Apply, secret, site write and update. `box` is `daedalus <mail sender>`;
   * `operator` is `fleet.operator.gitName` / `gitEmail`. The document names a
   * choice, never a name or an address: the host agents resolve it against
   * values nix baked into them (host/lib.sh `commit_identity`), so a planted
   * value can only pick one of the two. Who pressed the button stays in the
   * commit body either way. Nix does not read it; absent and
   * `{ author: 'box' }` are the same document, and the renderer drops the
   * block while it holds that.
   */
  commits: { author: CommitAuthor }
  /**
   * The switches moved from a page, and nothing else: `enabled.<id>` is
   * what `fleet.modules.<id>.enable` becomes on the next Apply, at a
   * priority the host's own files yield to. An id absent here keeps the
   * host's word. A structural module (the engine's spine plus what the host
   * adds) is refused here before it can reach nix, where it is an assertion.
   * Absent and `{ enabled: {} }` are the same document.
   *
   * `web.<webApp>` is the same idea for where a module's hostnames answer:
   * `label` becomes `fleet.webApps.<webApp>.hostname` as `<label>.<domain>`
   * and `public` becomes its `exposeRemotely`, each at the same priority. A
   * null field keeps the host's word, and a webApp with both null leaves
   * the document. Keyed by the webApp, not the module: a module publishes
   * several (grafana and prometheus are one), and nix reads it per webApp.
   *
   * `players.<id>` is a game server's whole roster, not an override: who may
   * join and who may run commands, each resolved from the vendor before it
   * was written (core/site/players.ts). Nix hands it to the stack as
   * `fleet.site.players.<id>`. An id with an empty list leaves the document.
   */
  modules: {
    enabled: Record<string, boolean>
    web: Record<string, SiteWebOverride>
    players: Record<string, SitePlayer[]>
  }
}

/** The git identities the box can commit as (`commits.author`). */
export const COMMIT_AUTHORS = ['box', 'operator'] as const
export type CommitAuthor = (typeof COMMIT_AUTHORS)[number]

/** One published hostname as the operator moved it (core/site/switches.ts). */
export type SiteWebOverride = { label: string | null; public: boolean | null }

/** One account on a game server's roster. `uuid` is dashed and lower-case. */
export type SitePlayer = { name: string; uuid: string; op: boolean }

/**
 * The box as the settings page describes it, as the document.
 *
 * Built from `BoxSettings` rather than from the export domains directly, so
 * the file and the page can never disagree about what this box is: if the
 * page is showing it, this is what gets written.
 *
 * It carries no `github` block, because the settings page does not know one.
 * That is safe only because core/site edits against this document solely when
 * no site.json exists yet; once one does, the committed document is the base,
 * and it carries the block.
 */
export function siteDocument(s: BoxSettings): SiteDocument {
  return {
    schemaVersion: 1,
    identity: {
      hostname: s.general.hostname,
      baseDomain: s.general.baseDomain,
      controlPlane: s.general.controlPlane.label,
      controlPlanePrevious: s.general.controlPlane.previousLabel,
      timezone: s.general.timezone,
      owner: s.general.owner,
      operator: { user: s.general.operator.user, group: s.general.operator.group },
    },
    network: {
      lanIp: s.network.lanIp,
      interface: s.network.interface,
      gateway: s.network.gateway,
      wanHost: s.network.wanHost,
      ddns: s.network.ddns,
      dhcp: s.network.dhcp,
      dnsUpstreams: s.network.dns.upstreams,
    },
    mail: s.integrations.mail,
    cloudflare: {
      accountId: s.integrations.cloudflare.accountId,
      zoneId: s.integrations.cloudflare.zoneId,
      tunnelId: s.integrations.cloudflare.tunnelId,
    },
    // Never read off the running box: the override is a statement about how
    // the NEXT Apply should build, and a system built from an override says
    // nothing about whether the next one should be.
    developer: { engineOverride: null },
    commits: { author: 'box' },
    // The running box's switches are its own files' word; the document
    // carries only what the operator moved, which a box read back is none.
    modules: { enabled: {}, web: {}, players: {} },
  }
}

/**
 * The inverse of the decoder's fallbacks. A field the decoder fills in when it
 * is absent is left out again while it holds exactly that fallback, so a file
 * written before the field existed re-renders to its own bytes. Nix reads the
 * absent label and the empty one alike, as unset.
 */
function identityAsWritten(identity: SiteDocument['identity']): Record<string, unknown> {
  if (identity.controlPlane !== '' || identity.controlPlanePrevious !== null) return identity
  return Object.fromEntries(
    Object.entries(identity).filter(([k]) => k !== 'controlPlane' && k !== 'controlPlanePrevious'),
  )
}

export function renderSiteFile(doc: SiteDocument): string {
  const { github, developer, commits, modules, ...rest } = doc
  const app = github?.app ?? null
  const switched = Object.keys(modules.enabled).sort()
  // A webApp is written while either field says something, each field only
  // while it does: a null is the host's word, and the host's word is absence.
  const moved = Object.keys(modules.web)
    .sort()
    .filter((n) => {
      const w = modules.web[n]
      return w !== undefined && (w.label !== null || w.public !== null)
    })
  const webAsWritten = Object.fromEntries(
    moved.map((n) => {
      const w = modules.web[n] as SiteWebOverride
      return [
        n,
        {
          ...(w.label === null ? {} : { label: w.label }),
          ...(w.public === null ? {} : { public: w.public }),
        },
      ]
    }),
  )
  // Ids sorted and each roster by name, so the same set is the same bytes.
  const rostered = Object.keys(modules.players)
    .sort()
    .filter((id) => (modules.players[id] ?? []).length > 0)
  const playersAsWritten = Object.fromEntries(
    rostered.map((id) => [
      id,
      [...(modules.players[id] ?? [])]
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
        .map((p) => ({ name: p.name, uuid: p.uuid, op: p.op })),
    ]),
  )
  const body = {
    ...PREAMBLE,
    ...rest,
    identity: identityAsWritten(rest.identity),
    // Same rule as the identity labels: the block exists in the file only
    // while it says something, so a document from before it re-renders to
    // its own bytes and clearing the override removes the block again.
    ...(developer.engineOverride === null
      ? {}
      : { developer: { engineOverride: developer.engineOverride } }),
    ...(commits.author === 'box' ? {} : { commits: { author: commits.author } }),
    // Same rule again, and the ids sorted, so two edits that end in the same
    // set render the same bytes.
    ...(switched.length === 0 && moved.length === 0 && rostered.length === 0
      ? {}
      : {
          modules: {
            ...(switched.length === 0
              ? {}
              : {
                  enabled: Object.fromEntries(
                    switched.map((id) => [id, modules.enabled[id] ?? false]),
                  ),
                }),
            ...(moved.length === 0 ? {} : { web: webAsWritten }),
            ...(rostered.length === 0 ? {} : { players: playersAsWritten }),
          },
        }),
    // Last, and copied key by key. The fixed order keeps a new App a single
    // block in the diff, and nothing else on the caller's object can reach a
    // committed file (the manifest conversion reply also carries the private key).
    ...(app === null
      ? {}
      : {
          github: {
            app: {
              id: app.id,
              slug: app.slug,
              clientId: app.clientId,
              htmlUrl: app.htmlUrl,
              owner: app.owner,
              ownerId: app.ownerId,
            },
          },
        }),
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/**
 * The directory's README. Rewritten with every write, like the rest — which
 * makes this function, and not the committed file, the source of truth for
 * what it says. Hand-improving the file in the repository is how the two
 * drifted once: the next write silently reverted it, and nothing surfaced
 * that, because README.md is not part of the digest set the Site tab compares.
 *
 * So: edit the text HERE, and let a write carry it into the directory.
 */
export function renderSiteReadme(doc: SiteDocument): string {
  return `# site/ — what ${doc.identity.hostname} is, as data

The one directory in this configuration that
[daedalus](https://github.com/${ENGINE_REPO}) writes. Nothing else
in the repository is touched by it — and everything generated in here is
written BY it, from the UI. A hand edit to a generated file lasts until the
next write and no longer.

| File | What it holds |
|---|---|
| \`site.json\` | The box's identity: domain, addresses, mail, the Cloudflare ids. |
| \`apps.json\` | The app registry — one entry per self-hosted app, exported from daedalus's database by an Apply. |
| \`daedalus.json\` | Provenance: which engine wrote this directory, when, and on whose say-so. |
| \`README.md\` | This file. |
| \`vault/\` | The box's own secrets, sops-encrypted: \`cloudflare-api-token.sops\` and \`github-app.sops\`. |
| \`.sops.yaml\` | Who can decrypt \`vault/\`. Hand-written, once; daedalus reads it to encrypt and never writes it. |

Which surface writes which file:

- **Settings › Site** writes \`site.json\`, this README and \`daedalus.json\`. It
  does not rebuild.
- **Apply** writes \`apps.json\`, \`site.json\` when the document changed, a
  \`vault/\` entry when a secret was replaced, and \`daedalus.json\` — and then
  rebuilds.

**Do not hand-edit \`apps.json\`.** It is generated from daedalus's \`apps\`
table, and only an Apply ever writes it — which is what keeps it from holding
drift that was never applied. Until the Apply lands, daedalus reports the app
as drifted. Edit it in the UI instead.

\`site.json\` is written by Settings › Site. Editing it by hand is allowed —
it is a plain JSON file and git is the audit trail — but daedalus will show
it as differing from what it would write, which is the honest reading until
the two agree again.

\`daedalus.json\` records which engine wrote this directory and when. **Nix
does not read it**: it is here so that a \`git log\` of this repository can say
which version of daedalus produced a commit. Anything it could not read is
\`null\` rather than guessed — a stamp that sometimes invents a revision is
worth less than no stamp at all.

Nothing readable is secret. \`site.json\`, \`apps.json\` and \`daedalus.json\`
are plain JSON; everything in \`vault/\` is sops ciphertext, safe to commit, and
readable only by the two recipients in \`.sops.yaml\` — the box and
${doc.identity.operator.user}'s age key. daedalus is neither: it writes those files
without ever being able to read one back — the container carries an
encrypt-only \`sops\` and no age key — so replacing a credential means pasting
the new value, never editing the old one.
`
}

/** Which of the two doors into the site directory did the writing. */
export type SiteStampDoor = 'apply' | 'site-write'

/**
 * The provenance stamp: which engine wrote this directory, and when.
 *
 * Every field is `| null` where the fact can be missing, and the gatherer
 * (core/site/index.ts) fills a null rather than a guess whenever the snapshot
 * it would read is absent, undecodable or stale. That rule is the whole value
 * of the file: a stamp that sometimes invents a revision is worth less than no
 * stamp, because a reader cannot tell the invented ones from the real ones.
 *
 * `dirty` is nullable for the same reason. A workspace daedalus cannot see is
 * not a clean one, and writing `false` there would be the one guess that reads
 * exactly like a fact.
 */
export type SiteStamp = {
  writtenAt: string
  writtenBy: { actor: string; door: SiteStampDoor }
  engine: {
    version: string | null
    /** 12 characters, as the workspace snapshot publishes it. */
    head: string | null
    dirty: boolean | null
    branch: string | null
  }
  /** The configuration repository this directory lives in, as it was BEFORE this write. */
  config: { revision: string | null }
  nixos: { version: string | null }
}

const STAMP_GENERATED =
  'Written by daedalus on every write into this directory: it records which engine wrote these files, when, and on whose say-so. Nix does not read it — it is provenance for a person reading the repository’s history.'

/**
 * The stamp's exact bytes. Key by key rather than by spread, like
 * renderSiteFile's github block: this renders into a committed file, and
 * nothing the caller happens to be carrying may reach one. Same byte
 * conventions as the rest of the directory — two spaces, trailing newline.
 */
export function renderSiteStamp(stamp: SiteStamp): string {
  const body = {
    _generated: STAMP_GENERATED,
    schemaVersion: 1,
    writtenAt: stamp.writtenAt,
    writtenBy: { actor: stamp.writtenBy.actor, door: stamp.writtenBy.door },
    engine: {
      version: stamp.engine.version,
      head: stamp.engine.head,
      dirty: stamp.engine.dirty,
      branch: stamp.engine.branch,
    },
    config: { revision: stamp.config.revision },
    nixos: { version: stamp.nixos.version },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}
