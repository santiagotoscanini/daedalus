// The exposure ladder an app climbs, bottom rung first.
//
// One tuple, so no file spells the rungs out by hand. The order is the
// ladder itself: every rung adds to the one below it, so `APP_STAGES.indexOf`
// is a real comparison and the pickers can render the list verbatim.
//
// Mirrors the `stage` option in nix/platform/apps-options.nix, which is where the rungs
// actually mean something:
//
//   off  — the container runs and deploys; nothing can reach it. No traefik
//          router, no DNS, no probe, no tunnel route.
//   lab  — LAN only, through pi-hole and traefik's wildcard certificate.
//   live — also published through the Cloudflare tunnel ("Public").
//
// A new app still waiting for its first image is not a rung: it carries its
// chosen stage and the `awaitingImage` marker, and nix makes nothing for it
// until the marker clears (lib/apps/setup.ts).
//
// Client-safe on purpose: the create form, the app list and the exposure
// picker all need these, and host/nix-manifest.ts builds its decoder from the
// same tuple so the file Nix reads can never disagree with the UI.

export const APP_STAGES = ['off', 'lab', 'live'] as const

export type AppStage = (typeof APP_STAGES)[number]

/** What the operator reads for each rung. */
export const STAGE_LABEL: Record<AppStage, string> = { off: 'Off', lab: 'Lab', live: 'Public' }

export const isAppStage = (v: unknown): v is AppStage =>
  typeof v === 'string' && (APP_STAGES as readonly string[]).includes(v)

/** Is there an ingress — a traefik router, a DNS name, a probe, an icon to fetch? */
export const stageExposed = (stage: string): boolean => stage === 'lab' || stage === 'live'

/** Is it reachable now: exposed, and past its first image (nothing exists before that). */
export const appReachable = (a: { stage: string; awaitingImage: boolean }): boolean =>
  !a.awaitingImage && stageExposed(a.stage)

/** The rungs the create form offers: nobody creates an app to be unreachable. */
export const NEW_APP_STAGES = ['lab', 'live'] as const satisfies readonly AppStage[]
export type NewAppStage = (typeof NEW_APP_STAGES)[number]
