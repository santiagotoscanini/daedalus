import type { ApplyStatus } from '../../lib/apply'
import type { RepoFacts } from '../../lib/contract/domains/repo'
import type { NixosFacts } from '../../lib/contract/domains/site'
import type { NixosCycle, NixosNotes, Support } from '../../lib/nixos'

// What the settings page renders. Types only — this file is imported by
// components, so nothing in it may pull a server module in by value.

/** How much to trust a section: whether its producer has run, and when. */
export type SourceMeta = {
  available: boolean
  stale: boolean
  generatedAt: string | null
  error: string | null
}

export type BoxSettings = {
  general: {
    hostname: string
    baseDomain: string
    publicUrl: string
    /** The control plane's hostname label, and the one a rename left answering beside it. */
    controlPlane: { label: string; previousLabel: string | null }
    timezone: string
    operator: { user: string; group: string; email: string }
    owner: string
    engine: {
      /** The commit the running generation was built from; null = built from a tree git did not describe. */
      revision: string | null
      nixosVersion: string | null
      /** The release in detail; null before the export carries it. */
      nixos: NixosFacts | null
    }
  }
  network: {
    lanIp: string
    interface: string | null
    gateway: string | null
    wanHost: string
    ddns: { host: string; interval: string }
    dhcp: { active: boolean; router: string; start: string; end: string; leaseTime: string }
    dns: { upstreams: string[]; lanHosts: number }
  }
  integrations: {
    cloudflare: {
      accountId: string
      zoneId: string
      tunnelId: string
      /** The one Cloudflare API token (DASH_CF_API_TOKEN) is present. */
      tokenConfigured: boolean
    }
    github: { owner: string; tokenConfigured: boolean; repoTokenConfigured: boolean }
    mail: { sender: string; alertTo: string }
    registryUrl: string
    grafanaUrl: string
  }
  repository: {
    facts: RepoFacts
    meta: SourceMeta
    applyStatus: ApplyStatus
    /** Same as general.engine.revision; here so the tab can say whether HEAD is what runs. */
    runningRevision: string | null
  }
  developer: {
    /** `source.mode = local`: the container runs the Vite dev server over a bind mount. */
    devServer: boolean
    node: string
    exportDir: string
    stateRoot: string
    applyDir: string
  }
  sources: { site: SourceMeta; network: SourceMeta }
}

/** A credential checked against the service that issued it. */
export type TokenCheck = {
  configured: boolean
  ok: boolean
  /** The issuer's own word for it (`active`, `expired`, …); null when unreachable. */
  status: string | null
  expiresOn: string | null
  error: string | null
}

export type CloudflareStatus = {
  token: TokenCheck
  zone: { name: string; status: string } | null
  tunnel: { name: string; status: string } | null
}

export type GithubCheck = {
  configured: boolean
  ok: boolean
  login: string | null
  /** From the token's prefix; a fine-grained token reports no scopes header. */
  kind: 'classic' | 'fine-grained' | 'unknown'
  scopes: string[]
  rateLimit: { remaining: number; limit: number; resetAt: string } | null
  error: string | null
}

export type IntegrationStatus = {
  checkedAt: string
  cloudflare: CloudflareStatus
  github: { token: GithubCheck; repoToken: GithubCheck }
  mail: { lastSentAt: string | null; lastRecipient: string | null }
}

/** Settings › Profile: the signed-in person's Pocket ID account. */
export type Profile = {
  id: string
  username: string
  firstName: string
  lastName: string
  displayName: string
  email: string
  emailVerified: boolean
  isAdmin: boolean
  /** Pocket ID group names, friendly name where there is one. */
  groups: string[]
  /** An LDAP-synced account; Pocket ID refuses edits to it. */
  managedByLdap: boolean
  /** Pocket ID's own account page, where passkeys are managed. '' when unknown. */
  accountUrl: string
  /** Changes when the picture does; it goes on the picture's URL so browsers ask again. */
  pictureVersion: number
}

/** The account button at the foot of the rail. */
export type Account = {
  /** Display name, else first and last name, else username. */
  name: string
  username: string
  email: string
  pictureVersion: number
  accountUrl: string
}

export type ProfileRead = { ok: true; profile: Profile } | { ok: false; reason: string }

/** The fields the page may change; everything else is re-sent as read. */
export type ProfilePatch = Partial<
  Pick<Profile, 'username' | 'firstName' | 'lastName' | 'displayName' | 'email'>
>

/** A zone the Cloudflare API token can see. */
export type CloudflareZone = { id: string; name: string; status: string }

/** What the domain picker offers, or why it cannot offer anything. */
export type ZoneList = { ok: true; zones: CloudflareZone[] } | { ok: false; reason: string }

/** The live half of the Engine card: support, the channel, the notes. */
export type NixosRelease = {
  checkedAt: string
  /** The running release as endoflife.date lists it; null when it did not answer. */
  running: NixosCycle | null
  support: Support | null
  /** The newest release already out, which may be the running one. */
  latest: NixosCycle | null
  latestSupport: Support | null
  channel: {
    /** `nixos-25.11` */
    branch: string
    /** The channel's newest commit; null when GitHub did not answer. */
    head: { sha: string; date: string } | null
    /** Commits on the channel past the locked revision; null when not compared. */
    newer: number | null
  }
  /** Newest release first: the latest release's notes, then the running one's. */
  notes: NixosNotes[]
  /** What could not be asked, as a sentence; null when everything answered. */
  note: string | null
}

/** Settings › General's deferred half. */
export type GeneralLive = { zones: ZoneList; nixos: NixosRelease }
