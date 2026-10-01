// A request body read whole, but never past a byte cap.
//
// Shared by the two doors outside the Pocket ID gate that take a body from
// whoever dials them: the GitHub webhook and a machine's enroll redeem. Each
// has a cap, and a cap checked AFTER `request.text()` is no cap — a chunked
// body carries no content-length, so the whole thing would already be in
// memory. The cap is enforced while reading, in bytes.

/**
 * The exact bytes received, or null past `cap`. An absent body is empty. The
 * stream is cancelled the moment the cap is passed, so a caller that sends
 * forever costs at most `cap` plus one chunk.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (stream === null) return new Uint8Array(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let chunk = await reader.read()
  while (!chunk.done) {
    total += chunk.value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(chunk.value)
    chunk = await reader.read()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  return bytes
}
