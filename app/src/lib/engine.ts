// The engine's own name — the one identity in this app that is NOT the box's.
//
// Everything else the app is spelled with (the domain, the GitHub owner, the
// registry host) is a `Site` value read from the container's env, because an
// image is built once and runs on every box. This is the exception: which
// repository the engine itself lives in is a fact about the engine, the same
// on every box, and the module that ships it is the right place to state it.
// A host never defines it — reading it from `fleet.github.owner` would make
// a stranger's box look for daedalus under their own account.
//
// Readers: the provenance stamp (core/site) and the Updates page's engine card
// (modules/system/data/updates.ts) find the engine's workspace clone by this
// slug; the Actions module lists the engine beside the box's own repos when
// they share an owner. The host agent that updates the engine needs no copy — it
// fast-forwards the clone from its own `origin`.

/** `owner/name` on GitHub, as the workspace snapshot spells a remote. */
export const ENGINE_REPO = 'santiagotoscanini/daedalus'
