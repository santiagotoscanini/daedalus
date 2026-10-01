import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { iconPlan, MAX_ICON_BYTES, servable, writeIcons } from './workspace-icons'

// The export half of `workspaces.icon`: which workspace shows which project's
// icon, and the directory the session host reads (session-host/src/
// workspaces.rs `icon`, which sniffs and caps the same way again).

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
const png = (body = PNG) => ({ body, contentType: 'image/png' })

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workspace-icons-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('iconPlan', () => {
  it('matches a workspace to a project by its remote, case-insensitively', () => {
    const plan = iconPlan(
      [
        { name: 'iris', remote: 'Owner/iris' },
        { name: 'site', remote: 'owner/portfolio' },
        { name: 'scratch', remote: null },
        { name: 'other', remote: 'someone/else' },
        { name: '../x', remote: 'owner/iris' },
      ],
      [
        { repo: 'owner/Iris', key: 'app:iris' },
        { repo: 'owner/portfolio', key: 'site:portfolio-example-com' },
      ],
    )
    expect([...plan]).toEqual([
      ['iris', 'app:iris'],
      ['site', 'site:portfolio-example-com'],
    ])
  })
})

describe('servable', () => {
  it('takes png, svg, ico and webp up to the cap, nothing else', () => {
    expect(servable(png())).toBe(true)
    expect(servable({ body: SVG, contentType: 'image/svg+xml' })).toBe(true)
    expect(servable({ body: PNG, contentType: 'image/jpeg' })).toBe(false)
    expect(servable({ body: Buffer.alloc(0), contentType: 'image/png' })).toBe(false)
    expect(servable(png(Buffer.alloc(MAX_ICON_BYTES + 1)))).toBe(false)
    expect(servable(png(Buffer.alloc(MAX_ICON_BYTES)))).toBe(true)
  })
})

describe('writeIcons', () => {
  it('writes one <workspace>.icon per icon, world-readable, raw bytes', async () => {
    const out = await writeIcons(
      new Map([
        ['iris', png()],
        ['hermes', { body: SVG, contentType: 'image/svg+xml' }],
      ]),
      dir,
    )
    expect(out.written.sort()).toEqual(['hermes', 'iris'])
    expect(await readFile(join(dir, 'iris.icon'))).toEqual(PNG)
    expect(await readFile(join(dir, 'hermes.icon'))).toEqual(SVG)
    expect((await stat(join(dir, 'iris.icon'))).mode & 0o777).toBe(0o644)
  })

  it('leaves unchanged bytes alone and removes what is no longer wanted', async () => {
    await writeIcons(
      new Map([
        ['iris', png()],
        ['gone', png()],
      ]),
      dir,
    )
    await writeFile(join(dir, 'crashed.icon.tmp'), 'x')
    await writeFile(join(dir, 'unrelated.txt'), 'x')
    const out = await writeIcons(new Map([['iris', png()]]), dir)
    expect(out).toEqual({ written: [], removed: ['gone'] })
    expect((await readdir(dir)).sort()).toEqual(['iris.icon', 'unrelated.txt'])
  })

  it('never writes an icon santree may not be handed, or a name that is not one component', async () => {
    const out = await writeIcons(
      new Map([
        ['big', png(Buffer.alloc(MAX_ICON_BYTES + 1))],
        ['jpeg', { body: PNG, contentType: 'image/jpeg' }],
        ['..', png()],
        ['a/b', png()],
      ]),
      dir,
    )
    expect(out.written).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })
})
