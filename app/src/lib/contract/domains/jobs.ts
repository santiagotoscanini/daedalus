import { join } from 'node:path'
import { arrayOf, bool, nullable, obj, optional, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/jobs.json — every scheduled job declared worth noticing, and HOW it
// is noticed. `email` means a failing run mails; `slug` means a run that
// stops happening pages through healthchecks. Different guarantees, and this
// registry is the only place the pair is stated.

export type MonitoredJob = { unit: string; email: boolean; slug: string | null }

const shape = obj({
  monitoredJobs: optional(
    arrayOf(obj({ unit: str, email: bool, slug: optional(nullable(str), null) })),
    [],
  ),
})

export async function monitoredJobsList(): Promise<MonitoredJob[]> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'jobs.json'),
    decoder: shape,
    fallback: { monitoredJobs: [] },
    acceptVersions: [1],
  })
  return r.data.monitoredJobs
}
