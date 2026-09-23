import type { Ctx } from '../../../core/ctx'
import { arrayOf, bool, num, obj, optional, str } from '../../../lib/contract/decode'
import { listNodes } from '../../../lib/repo/nodes'
import { collect, type RepoActions } from './collect'
import { type Access, ghRead } from './github'
import { type RunnerOs, runsOnOf } from './parse'
import { assembleWorkflows } from './workflows'

// The Runners tab: the machines on this network as the runners they could
// be, against the images the workflows ask for.
//
// Nothing here runs a job yet. What is real: which machines exist (this box
// and every approved node, with their OS and architecture), what each would
// answer to as a runner label set, how many jobs a month ask for that OS on
// GitHub's machines, and whether GitHub already knows any self-hosted runner
// on these repositories. What is drawn blurred is the design — a runner
// defined here, started per job, watched for load — and it waits on the
// second GitHub App that can register runners (PLAN.md, feature 11).

export type MachineRunner = {
  id: string
  name: string
  os: RunnerOs
  arch: string
  /** The box itself, as opposed to a node. */
  box: boolean
  online: boolean
  agentVersion: string | null
  lastSeenAgo: number | null
  /** What a runner on it would advertise. */
  labels: string[]
  /** Jobs in the window that asked GitHub for this OS. */
  demand: number
  /** Billed minutes those jobs cost in the window. */
  minutes: number
}

export type RegisteredRunners = {
  repo: string
  url: string
  access: Access
  runners: { name: string; os: string; status: string; busy: boolean; labels: string[] }[]
}

export type RunnersData = {
  machines: MachineRunner[]
  /** GitHub's own list, per repository, where the App can read it. */
  registered: RegisteredRunners[]
  /** Whether any repository answered the runners endpoint at all. */
  canListRunners: boolean
  demand: { os: RunnerOs; jobs: number; minutes: number; workflows: number }[]
  selfHostedInFiles: number
}

const runnersDecoder = obj({
  total_count: num,
  runners: arrayOf(
    obj({
      name: str,
      os: str,
      status: str,
      busy: optional(bool, false),
      labels: optional(arrayOf(obj({ name: str })), []),
    }),
  ),
})

const archLabel = (arch: string): string =>
  /aarch64|arm64/i.test(arch) ? 'ARM64' : /x86_64|amd64|x64/i.test(arch) ? 'X64' : arch

function osOf(s: string): RunnerOs {
  const l = s.toLowerCase()
  return l.includes('windows')
    ? 'windows'
    : l.includes('mac') || l.includes('darwin')
      ? 'macos'
      : l.includes('linux')
        ? 'linux'
        : 'unknown'
}

/** Jobs and minutes in the window by the OS they asked GitHub for. */
function demandOf(
  repos: RepoActions[],
  now: number,
): Record<RunnerOs, { jobs: number; minutes: number }> {
  const d: Record<RunnerOs, { jobs: number; minutes: number }> = {
    linux: { jobs: 0, minutes: 0 },
    windows: { jobs: 0, minutes: 0 },
    macos: { jobs: 0, minutes: 0 },
    unknown: { jobs: 0, minutes: 0 },
  }
  for (const r of repos) {
    for (const js of r.jobs.values()) {
      for (const j of js) {
        const on = runsOnOf(j.labels)
        if (!on.hosted || j.startedAt === null) continue
        const end = j.completedAt === null ? now : Date.parse(j.completedAt)
        const minutes = Math.ceil(Math.max(0, end - Date.parse(j.startedAt)) / 60_000)
        d[on.os].jobs++
        d[on.os].minutes += minutes
      }
    }
  }
  return d
}

export async function loadRunners(ctx: Ctx): Promise<RunnersData> {
  const now = Date.now()
  const [repos, nodes, uname] = await Promise.all([
    collect(ctx, now),
    listNodes().catch(() => []),
    ctx.prom.vector('node_uname_info'),
  ])
  const demand = demandOf(repos, now)
  const files = assembleWorkflows(repos).totals

  const boxArch = uname[0]?.metric.machine ?? 'x86_64'
  const boxName = uname[0]?.metric.nodename ?? 'this box'
  const machines: MachineRunner[] = [
    {
      id: 'box',
      name: boxName,
      os: 'linux',
      arch: boxArch,
      box: true,
      online: true,
      agentVersion: null,
      lastSeenAgo: null,
      labels: ['self-hosted', 'Linux', archLabel(boxArch)],
      demand: demand.linux.jobs,
      minutes: demand.linux.minutes,
    },
    ...nodes
      .filter((n) => n.state === 'approved')
      .map((n) => {
        const os = osOf(n.os)
        return {
          id: n.id,
          name: n.name,
          os,
          arch: n.arch,
          box: false,
          online: n.lastSeenAgo < 120,
          agentVersion: n.agentVersion,
          lastSeenAgo: n.lastSeenAgo,
          labels: [
            'self-hosted',
            os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : n.os,
            archLabel(n.arch),
          ],
          demand: demand[os].jobs,
          minutes: demand[os].minutes,
        }
      }),
  ]

  const registered: RegisteredRunners[] = await Promise.all(
    repos.map(async (r) => {
      const a = await ghRead(
        ctx,
        `/repos/${r.repo.fullName}/actions/runners?per_page=100`,
        runnersDecoder,
      )
      return {
        repo: r.repo.short,
        url: r.repo.url,
        access: a.access,
        runners: (a.value?.runners ?? []).map((x) => ({
          name: x.name,
          os: x.os,
          status: x.status,
          busy: x.busy,
          labels: x.labels.map((l) => l.name),
        })),
      }
    }),
  )

  return {
    machines,
    registered,
    canListRunners: registered.some((r) => r.access === 'app'),
    demand: (['linux', 'windows', 'macos'] as const).map((os) => ({
      os,
      jobs: demand[os].jobs,
      minutes: demand[os].minutes,
      workflows: files.images[os],
    })),
    selfHostedInFiles: files.selfHosted,
  }
}
