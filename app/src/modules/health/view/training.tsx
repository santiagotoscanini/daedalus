import { FOOT } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import type { HealthData } from '../data'
import { ServerPair } from './shared'

// Health › Training: the Hevy MCP server — workouts, routines and body
// measurements from Hevy, as tools on the LLM gateway.

type Training = Extract<HealthData, { tab: 'training' }>

export function TrainingView({ data: d }: { data: Training }) {
  return (
    <BoardGrid>
      <ServerPair
        label="Hevy MCP"
        container="mcp-hevy"
        version={d.version}
        gap={d.gap}
        note={
          <p className={FOOT}>
            Workouts, routines, exercise templates and body measurements over Hevy&rsquo;s public
            API: read, create and update, with no delete tools. It speaks streamable HTTP itself, so
            unlike Yazio there is no wrapper, and its sessions idle out after thirty minutes.
            Upstream exports telemetry to its author&rsquo;s collector unless HEVY_MCP_TELEMETRY=0
            is set.
          </p>
        }
      />
    </BoardGrid>
  )
}
