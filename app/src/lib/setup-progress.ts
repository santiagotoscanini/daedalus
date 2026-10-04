// The shape of a new app's way to its first container (lib/apps/setup.ts
// decides it, components/apps/setup-line.tsx draws it). Client-safe.

/** The four steps the app page draws for a new app, in order. */
export const SETUP_STEPS = ['setting up', 'building', 'starting', 'running'] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export type SetupProgress = {
  step: SetupStep
  /** The step stopped: what failed, in the host's words; Retry runs it again. */
  failed: { what: 'register' | 'build' | 'apply'; detail: string } | null
  /** Something worth a line that is not a failure. */
  note: string | null
  /** The build the line is about, for its log. */
  buildId: string | null
}
