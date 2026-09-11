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
    /** The GitHub account the app repos and CI live under. */
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
}

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
  const { github, ...rest } = doc
  const app = github?.app ?? null
  const body = {
    ...PREAMBLE,
    ...rest,
    identity: identityAsWritten(rest.identity),
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
 * The directory's README. Rewritten with every write, like the rest — it is
 * short and says what the directory is, which is the one thing a person
 * landing in `site/` from a `git log` needs before touching anything.
 */
export function renderSiteReadme(doc: SiteDocument): string {
  return `# site/ — what ${doc.identity.hostname} is, as data

The one directory in this configuration that
[daedalus](https://github.com/santiagotoscanini/daedalus) writes. Nothing else
in the repository is touched by it.

| File | What it holds |
|---|---|
| \`site.json\` | The box's identity: domain, addresses, mail, the Cloudflare ids. |
| \`apps.json\` | The app registry — one entry per self-hosted app, exported from daedalus's database by an Apply. |

**Do not hand-edit \`apps.json\`.** It is generated from daedalus's \`apps\`
table and overwritten on the next Apply; daedalus reports the app as drifted
until then. Edit it in the UI instead.

\`site.json\` is written by Settings › Site. Editing it by hand is allowed —
it is a plain JSON file and git is the audit trail — but daedalus will show
it as differing from what it would write, which is the honest reading until
the two agree again.

Nothing secret is in here. Credentials live in the box's encrypted secret
tree; when this directory gains a vault, its values are encrypted with
\`sops\` and only the box can read them.
`
}
