import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Decoder, decode } from './contract/decode'

// The file-drop bridge: how this container asks the host to do privileged
// things without holding any privilege itself.
//
// One directory (the /apply bind mount), one request file per verb, one status
// file the host writes back. A systemd.path unit on the host watches each
// request file and starts the matching root-side service; the trust boundary
// is "can write into /apply", and the Pocket ID gate in front of the app is
// what guards that. apply.ts, deploy.ts and build-bridge.ts each instantiate
// this with their own file names and status shape — the mechanics live here
// once.

export type BridgeStatus = { id: string | null; state: string }

/**
 * Temp + rename, because the host's path units fire on rename-into-place (and
 * on close-after-write): written in place, the agent could start against a
 * half-serialised file. The temp lives next to the target — rename cannot
 * cross filesystems.
 */
export async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

/** Throttled server-side complaint: a broken host agent says so once a minute. */
const lastLogged = new Map<string, number>()
function logOnce(file: string, message: string): void {
  const now = Date.now()
  if (now - (lastLogged.get(file) ?? 0) < 60_000) return
  lastLogged.set(file, now)
  console.error(`[bridge] ${file}: ${message}`)
}

export function defineBridge<S extends BridgeStatus>(opts: {
  requestFile: string
  statusFile: string
  /**
   * The status file's shape, as a decoder rather than a cast.
   *
   * The file is written by a root-side agent this container cannot see, one
   * release at a time: every field is `optional(…, <resting value>)` so a
   * status from an older agent still reads, and decoding `{}` IS the idle
   * status. That is why there is no separate idle literal beside this — one
   * that drifted from the shape would be the bug the decoder exists to catch.
   */
  status: Decoder<S>
}): {
  idle: S
  readStatus: () => Promise<S>
  request: (body: Record<string, unknown>, payload?: string) => Promise<string>
} {
  // Read per call rather than at module load so tests can point a bridge at a
  // temp directory; in the container the value never changes.
  const dir = (): string => process.env.APPLY_DIR ?? '/apply'
  const idle = decode(opts.status, {})

  return {
    idle,

    async readStatus(): Promise<S> {
      let raw: string
      try {
        raw = await readFile(join(dir(), opts.statusFile), 'utf8')
      } catch {
        // No status file yet — nothing has ever been requested from here.
        return idle
      }
      // Past this point the file EXISTS, so anything wrong with it is a broken
      // agent rather than a quiet resting state. Both still read as idle to the
      // caller — `S` has nowhere to put "unreadable" — but only one of them
      // leaves a line saying which field was wrong.
      try {
        return decode(opts.status, JSON.parse(raw))
      } catch (e) {
        logOnce(opts.statusFile, e instanceof Error ? e.message : 'unreadable status file')
        return idle
      }
    },

    /**
     * Publish a request. Returns the id, which the caller polls for.
     *
     * The payload (when there is one) is written FIRST and the request file
     * LAST: the request is what the path unit watches, so the trigger must
     * not fire before the bytes it points at exist.
     *
     * It lands at `payload-<id>.json` — stamped with the request's own id, and
     * the host derives the same name from the id it read, so nothing in the
     * request body names a path. A second request queued while the host is
     * mid-run therefore cannot overwrite the bytes the first one is committing
     * (a fixed payload name was the last TOCTOU sliver in this bridge).
     */
    async request(body: Record<string, unknown>, payload?: string): Promise<string> {
      const id = randomUUID()
      await mkdir(dir(), { recursive: true })
      if (payload !== undefined) await writeAtomic(join(dir(), `payload-${id}.json`), payload)
      await writeAtomic(
        join(dir(), opts.requestFile),
        `${JSON.stringify({ id, requestedAt: new Date().toISOString(), ...body }, null, 2)}\n`,
      )
      return id
    },
  }
}
