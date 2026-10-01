import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MCP_DOCS } from './docs'

// The documents reach the container only because the Dockerfile copies them,
// so the table and that COPY line are one fact in two files. In the dev
// container app/ is mounted alone at /app and the whole engine read-only at
// /engine, so the repository root is looked for there next — a missing file
// fails, never skips.
function repoFile(name: string): string {
  const candidates = [
    fileURLToPath(new URL(`../../../../${name}`, import.meta.url)),
    `/engine/${name}`,
  ]
  const found = candidates.find((path) => existsSync(path))
  if (found === undefined) throw new Error(`${name} not found at ${candidates.join(' or ')}`)
  return readFileSync(found, 'utf8')
}

describe('the MCP design documents', () => {
  const dockerfile = repoFile('Dockerfile')
  const copy = /^COPY ((?:\S+\.md )+)\/opt\/daedalus\/docs\/$/m.exec(dockerfile)

  it('are copied into the image where the reader looks', () => {
    expect(copy, 'no `COPY <docs> /opt/daedalus/docs/` line in the Dockerfile').not.toBeNull()
    expect(copy?.[1]?.trim().split(' ').sort()).toEqual(MCP_DOCS.map((d) => d.file).sort())
  })

  it('are let through the build context', () => {
    const ignore = repoFile('.dockerignore').split('\n')
    for (const d of MCP_DOCS) expect(ignore).toContain(`!${d.file}`)
  })

  it('exist at the repository root', () => {
    for (const d of MCP_DOCS) expect(repoFile(d.file).length).toBeGreaterThan(0)
  })
})
