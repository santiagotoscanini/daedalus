import type { ApplyStatus } from '../../lib/apply'
import type { RepoFacts } from '../../lib/contract/domains/repo'

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
    timezone: string
    operator: { user: string; email: string }
    owner: string
    engine: {
      /** The commit the running generation was built from; null = built from a tree git did not describe. */
      revision: string | null
      nixosVersion: string | null
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
      dnsTokenConfigured: boolean
      apiTokenConfigured: boolean
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
  dns: TokenCheck
  api: TokenCheck
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
