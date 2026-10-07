import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import { BoardGrid } from '../../../components/viz'
import type { HealthData } from '../data'
import { gapTitle, VersionAside } from './shared'

// Health › Nutrition: the Yazio MCP server — the food diary, weight and water
// that Yazio holds, as tools on the LLM gateway.

type Nutrition = Extract<HealthData, { tab: 'nutrition' }>

export function NutritionView({ data: d }: { data: Nutrition }) {
  return (
    <>
      <ServiceHead
        logo="/icon-yazio.png"
        name="Yazio MCP"
        version={d.version}
        versionNote="pinned in the image tag"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from the build')}
        lede={
          <>
            Meals, water, weight and goals from Yazio, readable and writable by a model through the
            gateway. A stdio-only server, so supergateway sits in front of it and spawns one per
            session: each is a fresh Yazio login, and a wrong password shows in the log below as
            &ldquo;Failed to authenticate&rdquo; on every call while the container itself stays up.
          </>
        }
      />

      <BoardGrid>
        {/* Two projects in one image, each with its own release cycle: two
            changelogs and the one log, rather than one changelog speaking for
            both. */}
        <Changelog
          gap={d.gap}
          span={12}
          title={gapTitle('yazio-mcp', d.gap)}
          aside={<VersionAside version={d.version} />}
        />
        <Changelog
          gap={d.supergateway.gap}
          span={12}
          title={gapTitle('supergateway', d.supergateway.gap)}
          aside={<VersionAside version={d.supergateway.version} />}
        />
        <LogBoard source={{ container: 'mcp-yazio' }} title="Yazio MCP logs" />
      </BoardGrid>
    </>
  )
}
