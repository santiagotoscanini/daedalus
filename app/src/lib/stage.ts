// The exposure ladder an app climbs, bottom rung first.
//
// One tuple, so no file spells the rungs out by hand. The order is the
// ladder itself: every rung adds to the one below it, so `APP_STAGES.indexOf`
// is a real comparison and the pickers can render the list verbatim.
//
// Mirrors the `stage` option in nix/modules/apps/apps.nix, which is where the rungs
// actually mean something:
//
//   declared — nothing runs. No container, no deploy unit, no ingress. The row
//              exists and so do the cheap durable things it will want: its
//              postgres role and database, its data dir, its AUTH_SECRET. This
//              is the rung every app sits on between "the entry exists" and
//              "there is an image to run", and it is what makes a new app
//              possible at all: the box only builds what is already in
//              site/apps.json, and applying an entry whose image does not
//              exist yet would declare a container that cannot pull, fail the
//              switch, and roll the Apply back.
//   off      — the container runs and deploys; nothing can reach it. No
//              traefik router, no DNS, no probe, no tunnel route.
//   lab      — LAN only, through pi-hole and traefik's wildcard certificate.
//   live     — also published through the Cloudflare tunnel.
//
// Client-safe on purpose: the create form, the app list and the exposure
// picker all need these, and host/nix-manifest.ts builds its decoder from the
// same tuple so the file Nix reads can never disagree with the UI.

export const APP_STAGES = ['declared', 'off', 'lab', 'live'] as const

export type AppStage = (typeof APP_STAGES)[number]

export const isAppStage = (v: unknown): v is AppStage =>
  typeof v === 'string' && (APP_STAGES as readonly string[]).includes(v)

/**
 * Does anything run at all?
 *
 * Takes a plain string because that is what the `stage` column is (text, see
 * host/schema.ts) — narrowing at every read would only move the same question
 * to a cast.
 */
export const stageRuns = (stage: string): boolean => stage !== 'declared'

/** Is there an ingress — a traefik router, a DNS name, a probe, an icon to fetch? */
export const stageExposed = (stage: string): boolean => stage === 'lab' || stage === 'live'
