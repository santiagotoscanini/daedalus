import { join } from 'node:path'
import { arrayOf, bool, literal, nullable, num, obj, optional, recordOf, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/publishing.json — the publish registry as platform/publishing.nix
// declares it: the FULL per-webApp record (the old manifest exported only
// hostname, which is why the dashboard grew hardcoded host ports), the
// taken-hostname list for the live collision check, direct ingress, and the
// VPN egress map daedalus.nix derives from the tenants' own netns flags.

const ns = optional(nullable(str), null)

export type WebAppRecord = {
  hostname: string
  port: number | null
  serviceName: string | null
  serviceUrl: string | null
  exposeRemotely: boolean
  auth: 'none' | 'oidc'
  healthPath: string | null
  isolated: boolean
}

export type PublishingFacts = {
  webApps: Record<string, WebAppRecord>
  takenHostnames: string[]
  directIngress: { name: string; port: number; proto: string; note: string }[]
  vpnEgress: {
    container: string
    exporter: string
    job: string
    controlPort: number
    subject: string
    provider: string
    keyExpiry: string
    runbook: string
    portForwarding: boolean
    tenants: string[]
  }[]
}

const shape = obj({
  webApps: recordOf(
    obj({
      hostname: str,
      port: optional(nullable(num), null),
      serviceName: ns,
      serviceUrl: ns,
      exposeRemotely: optional(bool, false),
      auth: optional(literal('none', 'oidc'), 'none'),
      healthPath: ns,
      isolated: optional(bool, false),
    }),
  ),
  takenHostnames: optional(arrayOf(str), []),
  directIngress: optional(
    arrayOf(obj({ name: str, port: num, proto: str, note: optional(str, '') })),
    [],
  ),
  vpnEgress: optional(
    arrayOf(
      obj({
        container: str,
        exporter: str,
        job: str,
        controlPort: num,
        subject: optional(str, ''),
        provider: optional(str, ''),
        keyExpiry: optional(str, ''),
        runbook: optional(str, ''),
        portForwarding: optional(bool, false),
        tenants: optional(arrayOf(str), []),
      }),
    ),
    [],
  ),
})

const EMPTY: PublishingFacts = { webApps: {}, takenHostnames: [], directIngress: [], vpnEgress: [] }

export async function publishingFacts(): Promise<PublishingFacts> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'publishing.json'),
    decoder: shape,
    fallback: EMPTY,
    acceptVersions: [1],
  })
  return r.data
}
