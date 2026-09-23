// The Actions module's data half: GitHub Actions, read as the box's App and,
// for what the App may not read, as anyone.
//
// Four tabs over one collection (./collect.ts): the runs of the last thirty
// days across every repository the box watches, the jobs behind the recent
// ones, and every workflow file. Runs is the feed; Workflows is what the
// files say; Minutes is what the month cost; Runners is this network's
// machines against that demand.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { loadMinutes, type MinutesData } from './minutes'
import { loadRunners, type RunnersData } from './runners'
import { loadRuns, type RunsData } from './runs'
import { loadWorkflows, type WorkflowsData } from './workflows'

export type Tabs = {
  runs: RunsData
  workflows: WorkflowsData
  minutes: MinutesData
  runners: RunnersData
}
export type ActionsData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  runs: loadRuns,
  workflows: loadWorkflows,
  minutes: loadMinutes,
  runners: loadRunners,
})
