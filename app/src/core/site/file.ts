import type { BoxSettings } from '../settings/types'

// Renders the site repository's files — the exact bytes that land in it.
//
// The same division of labour as lib/registry-file.ts, for the same reason:
// the host agent copies bytes and commits them, and every decision about
// SHAPE is application logic, where it can be typed and tested. site-init.sh
// never builds JSON.
//
// What this file is: the box's own description of itself, in the one format
// that is not code. Today it is written FROM what nix already says (the
// /export domains and the env binds daedalus.nix makes), which makes it a
// mirror worth nothing on its own — and that is exactly the point of this
// phase. It has to be provably identical to what the system is built from
// before anything is allowed to build from it instead.
//
// Formatting is load-bearing, like the registry's: two spaces, trailing
// newline, keys in a stable order, so that changing one setting later
// produces a one-line diff in a repository a human reads.

const PREAMBLE = {
  _generated:
    'Managed by daedalus. Written from the box’s running configuration and committed by the Initialize action in Settings › Site repository. Hand edits are kept — daedalus only rewrites this file when you ask it to — but anything it does rewrite comes from the UI.',
  _why: 'Configuration that is data, not code: what THIS box is, separated from the engine that builds it. Nix reads it as a pinned flake input, so a change here is a commit and a rebuild, and the repository stays the whole account of how the machine got the way it is.',
}

export type SiteDocument = {
  schemaVersion: 1
  identity: {
    hostname: string
    baseDomain: string
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
}

/**
 * The box as the settings page describes it, as the document.
 *
 * Built from `BoxSettings` rather than from the export domains directly, so
 * the file and the page can never disagree about what this box is: if the
 * page is showing it, this is what gets written.
 */
export function siteDocument(s: BoxSettings): SiteDocument {
  return {
    schemaVersion: 1,
    identity: {
      hostname: s.general.hostname,
      baseDomain: s.general.baseDomain,
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

export function renderSiteFile(doc: SiteDocument): string {
  return `${JSON.stringify({ ...PREAMBLE, ...doc }, null, 2)}\n`
}

/**
 * The repository's front page.
 *
 * Written once, at Initialize, and never rewritten: an operator who edits it
 * is describing their own box, and the mirror check deliberately does not
 * look at it. It exists because this repo gets pushed to a git host, where
 * the first thing anyone sees is a directory of JSON with no explanation of
 * what would happen if they edited it.
 */
export function renderSiteReadme(doc: SiteDocument): string {
  return `# ${doc.identity.hostname} — site

What this machine is, as data. Managed by
[daedalus](https://daedalus.toscanini.me), the control plane running on it.

| File | What it holds |
|---|---|
| \`site.json\` | The box's identity: domain, addresses, mail, the Cloudflare ids. |
| \`apps.json\` | The app registry — one entry per self-hosted app, exported from daedalus's database. |

**Do not hand-edit \`apps.json\`.** It is generated from daedalus's \`apps\`
table and overwritten on the next Apply; daedalus reports the app as drifted
until then. Edit it in the UI instead.

\`site.json\` is written by Settings › Site repository. Editing it by hand is
allowed — it is a plain JSON file and git is the audit trail — but daedalus
will show it as differing from what the running system was built with, which
is the honest reading until a rebuild.

Nothing secret is in here. Credentials live in the box's own encrypted secret
tree; when this repository gains a vault, the values in it are encrypted with
\`sops\` and only the box can read them.
`
}
