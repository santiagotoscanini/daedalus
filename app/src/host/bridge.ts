import { rename, writeFile } from 'node:fs/promises'

// What is left of the file-drop bridge: the two files the app still drops
// into the /apply mount for the host to pick up (host/dhcp-hosts.ts,
// lib/dashboard/board-releases.ts).

/**
 * Temp + rename, because the host's path units fire on rename-into-place (and
 * on close-after-write): written in place, the reader could start against a
 * half-serialised file. The temp lives next to the target — rename cannot
 * cross filesystems.
 */
export async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}
