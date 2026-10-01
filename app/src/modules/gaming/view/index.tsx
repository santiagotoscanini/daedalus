import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { FactorioView } from './factorio'
import { MinecraftView } from './minecraft'

// The Gaming page. Two servers, and the shape held.
//
// Both lead with the version rather than with uptime because that is the fact
// that actually breaks things here: a client on a different build cannot join
// at all, so "am I current" is the question. Whether it is up is answered by
// the dot on the tab — the manifest's `probe`/`health` (../manifest.ts);
// Minecraft's comes from the game's own status ping (server/tab-status.ts,
// `minecraft-ping`).
//
// ── one number on the page, and its comparisons on demand ─────────────────
//
// The running version is the only one stated outright. What the vendor calls
// current (Wube's stable and experimental, Mojang's latest release) is what
// it is measured AGAINST, not a fact about this server, and as headline
// cards those read as unrelated versions competing for the same glance. They
// live in ServiceHead's `compare`, behind the verdict chip that already says
// the answer ("current").

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  factorio: FactorioView,
  minecraft: MinecraftView,
})
