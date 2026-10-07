import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import { MONO } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import type { HealthData } from '../data'
import { LogFoot } from './shared'

// Health › Training: the Hevy MCP server — workouts, routines and body
// measurements from Hevy, as tools on the LLM gateway.

type Training = Extract<HealthData, { tab: 'training' }>

export function TrainingView({ data: d }: { data: Training }) {
  return (
    <>
      <ServiceHead
        logo="/icon-hevy.png"
        name="Hevy MCP"
        version={d.version}
        versionNote="pinned in the image tag"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from the image tag')}
        lede={
          <>
            Workouts, routines, exercise templates and body measurements over Hevy&rsquo;s public
            API: read, create and update, with no delete tools.
          </>
        }
      />

      <BoardGrid>
        <Changelog gap={d.gap} span={12} />
        <LogBoard
          source={{ container: 'mcp-hevy' }}
          title="Hevy MCP logs"
          foot={
            <LogFoot container="mcp-hevy">
              It speaks streamable HTTP itself, so there is no wrapper, and its sessions idle out
              after thirty minutes. Upstream exports telemetry to its author&rsquo;s collector
              unless
              <span className={MONO}>HEVY_MCP_TELEMETRY=0</span> is set.
            </LogFoot>
          }
        />
      </BoardGrid>
    </>
  )
}
