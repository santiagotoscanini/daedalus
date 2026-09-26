// The Gaming module's data half — two game servers, asked the same three questions.
//
// Its own page rather than a corner of Home because the questions are its
// own: which version is running, can the clients on the sofa still join it,
// and what has the vendor shipped since.
//
// The two tabs answer those from opposite ends. Factorio has an admin UI and
// no way to be asked anything by a machine — RCON never leaves ofsm's netns —
// so the version facts come from the vendor and the pin, and the only live
// reads are second-hand: the container gauge, and what the game states about
// itself in its own log. Minecraft has no admin UI at all and answers the
// server-list ping, so its numbers are first-hand — how many people are on
// right now, and how long the server took to say so.
//
// The version facts and their sources are in factorio.ts and minecraft.ts,
// one file per tab.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type FactorioData, loadFactorio } from './factorio'
import { loadMinecraft, type MinecraftData } from './minecraft'

/**
 * One shape per tab. `TabPayload` turns this into a union keyed on `tab`
 * rather than one shape with optional fields, so the Minecraft view cannot
 * read a Factorio number that is not there.
 */
export type Tabs = { factorio: FactorioData; minecraft: MinecraftData }
export type GamingData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  factorio: loadFactorio,
  minecraft: loadMinecraft,
})
