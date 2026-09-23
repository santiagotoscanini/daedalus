import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { MinutesView } from './minutes'
import { RunnersView } from './runners'
import { RunsView } from './runs'
import { WorkflowsView } from './workflows'

// The Actions page — GitHub Actions across the box's repositories, and the
// runners this network could lend them.
//
// Separate from Apps on purpose. The apps never touch Actions: a push builds
// on the box through daedalus's own webhook, and GitHub sees a check run and
// a Deployment. Actions is everything ELSE those repositories do — checks on
// pull requests, releases, the website's deploy, the agent's signed builds —
// and the minutes it costs on GitHub's machines, which this network has the
// machines to replace.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  runs: ({ data }) => <RunsView d={data} />,
  workflows: ({ data }) => <WorkflowsView d={data} />,
  minutes: ({ data }) => <MinutesView d={data} />,
  runners: ({ data }) => <RunnersView d={data} />,
})
