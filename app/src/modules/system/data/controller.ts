import type { Ctx } from '../../../core/ctx'

/**
 * The box's controller as it answers over its socket — the agent the app
 * will reach every machine through (PLAN, feature 13). Claude is the
 * controller's own report, not the box's Claude, which is still the Claude
 * tab's (the snapshot and its unit): the controller advertises remote
 * control, and on this box it is switched off.
 */
export type ControllerData =
  | {
      reachable: true
      version: string
      mode: string
      api: number
      uptimeSecs: number
      telemetry: string
      capabilities: string[]
      /** Null when the controller does not offer `claude.remote_control`, or its answer failed. */
      claude: { wanted: boolean; reporting: boolean; state: string | null } | null
    }
  | { reachable: false; error: string }

export async function loadController(ctx: Ctx): Promise<ControllerData> {
  try {
    const info = await ctx.controller.systemInfo()
    const claude = info.capabilities.includes('claude.remote_control')
      ? await ctx.controller.claudeStatus().catch(() => null)
      : null
    return {
      reachable: true,
      version: info.version,
      mode: info.mode,
      api: info.api,
      uptimeSecs: info.uptimeSecs,
      telemetry: info.telemetry,
      capabilities: info.capabilities,
      claude:
        claude === null
          ? null
          : {
              wanted: claude.wanted,
              reporting: claude.reporting,
              state: claude.report?.state ?? null,
            },
    }
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) }
  }
}
