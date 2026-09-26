import { describe, expect, it } from 'vitest'
import { EnvError, EnvFormatError, envSchema, makeEnv, parsers, SCHEMA } from './env'

const REQUIRED = { DATABASE_URL: 'postgres://u:hunter2@pg:5432/daedalus' }

function envOf(vars: Record<string, string | undefined>) {
  const warnings: string[] = []
  return {
    env: makeEnv(
      () => vars,
      (line) => warnings.push(line),
    ),
    warnings,
  }
}

describe('the validators', () => {
  it('takes an http(s) URL as written and refuses anything else', () => {
    expect(parsers.url('http://litellm:4000')).toBe('http://litellm:4000')
    expect(parsers.url('https://x.example/ui/')).toBe('https://x.example/ui/')
    for (const bad of ['litellm:4000', 'ftp://x', 'not a url', '/export']) {
      expect(() => parsers.url(bad), bad).toThrow(EnvFormatError)
    }
  })

  it('takes a postgres URL under either scheme', () => {
    expect(parsers.dsn('postgres://u@h/db')).toBe('postgres://u@h/db')
    expect(parsers.dsn('postgresql://u@h/db')).toBe('postgresql://u@h/db')
    expect(() => parsers.dsn('http://h/db')).toThrow(EnvFormatError)
  })

  it('takes whole numbers only', () => {
    expect(parsers.int('130')).toBe(130)
    expect(parsers.int('-4')).toBe(-4)
    for (const bad of ['1.5', '12abc', ' 12', '1e3', '9007199254740993']) {
      expect(() => parsers.int(bad), bad).toThrow(EnvFormatError)
    }
  })

  it('reads a flag as nix writes one', () => {
    expect(parsers.flag('1')).toBe(true)
    expect(parsers.flag('0')).toBe(false)
    for (const bad of ['true', 'yes', 'on']) {
      expect(() => parsers.flag(bad), bad).toThrow(EnvFormatError)
    }
  })

  it('splits a comma list, dropping what is empty', () => {
    expect(parsers.list('a.example, b.example,,')).toEqual(['a.example', 'b.example'])
    expect(parsers.list(',')).toEqual([])
  })

  it('wants a path absolute', () => {
    expect(parsers.path('/export')).toBe('/export')
    expect(() => parsers.path('export')).toThrow(EnvFormatError)
  })
})

describe('the schema', () => {
  it('gives every fallback a value its own kind accepts', () => {
    for (const row of envSchema) {
      if (row.fallback === undefined) continue
      expect(() => parsers[row.kind](row.fallback as string), row.name).not.toThrow()
    }
  })

  it('marks every DASH_ row a secret read through host/keys.ts', () => {
    for (const row of envSchema.filter((r) => r.name.startsWith('DASH_'))) {
      expect(row.secret, row.name).toBe(true)
      expect(row.reader, row.name).toBe('host/keys.ts')
    }
  })

  it('requires the database and leaves the gateway optional', () => {
    expect(envSchema.filter((r) => r.required).map((r) => r.name)).toEqual(['DATABASE_URL'])
    expect('required' in SCHEMA.LITELLM_BASE_URL).toBe(false)
    expect('required' in SCHEMA.LITELLM_API_KEY).toBe(false)
  })
})

describe('a required variable', () => {
  it('is fatal when missing, in one sentence that names it', () => {
    const { env } = envOf({})
    expect(() => env.get('DATABASE_URL')).toThrow(EnvError)
    expect(() => env.get('DATABASE_URL')).toThrow(/^DATABASE_URL is not set/)
    expect(env.check().fatal).toHaveLength(1)
    expect(env.check().fatal[0]).toMatch(/^DATABASE_URL is not set.*stacks\/app-db/)
  })

  it('is fatal when empty, which is how an unrendered binding arrives', () => {
    expect(() => envOf({ DATABASE_URL: '' }).env.get('DATABASE_URL')).toThrow(EnvError)
  })

  it('is fatal when malformed, without repeating the value', () => {
    const { env } = envOf({ DATABASE_URL: 'hunter2-not-a-url' })
    expect(() => env.get('DATABASE_URL')).toThrow(/is set but is not a postgres:\/\/ URL/)
    expect(env.check().fatal.join(' ')).not.toContain('hunter2')
  })

  it('reads as itself when it is there', () => {
    expect(envOf(REQUIRED).env.get('DATABASE_URL')).toBe(REQUIRED.DATABASE_URL)
  })
})

describe('an optional variable', () => {
  it('reads as absent when unset or empty, and says nothing', () => {
    const { env, warnings } = envOf(REQUIRED)
    expect(env.get('LITELLM_BASE_URL')).toBeUndefined()
    expect(env.text('DDNS_HOST')).toBeUndefined()
    expect(warnings).toEqual([])
    expect(env.check()).toEqual({ fatal: [], warnings: [] })
  })

  it('reads as absent when malformed, with one warning however often it is read', () => {
    const { env, warnings } = envOf({ ...REQUIRED, LITELLM_BASE_URL: 'litellm:4000/s3cret' })
    expect(env.get('LITELLM_BASE_URL')).toBeUndefined()
    expect(env.text('LITELLM_BASE_URL')).toBeUndefined()
    expect(env.get('LITELLM_BASE_URL')).toBeUndefined()
    expect(warnings).toEqual([
      '[env] LITELLM_BASE_URL is set but is not an http(s) URL; reading it as unset.',
    ])
    expect(env.check().warnings.map((w) => w.name)).toEqual(['LITELLM_BASE_URL'])
    expect(JSON.stringify(env.check())).not.toContain('s3cret')
  })

  it('falls back to its default when unset, and when malformed', () => {
    expect(envOf(REQUIRED).env.get('EXPORT_DIR')).toBe('/export')
    const { env, warnings } = envOf({ ...REQUIRED, LOKI_URL: 'loki:3100' })
    expect(env.get('LOKI_URL')).toBe('http://loki:3100')
    expect(warnings).toEqual([
      '[env] LOKI_URL is set but is not an http(s) URL; reading it as its default.',
    ])
  })

  it('parses by kind through get and hands back the bound string through text', () => {
    const { env } = envOf({ ...REQUIRED, GITHUB_APP_ENABLED: '1', MINECRAFT_PAPER_BUILD: '130' })
    expect(env.get('GITHUB_APP_ENABLED')).toBe(true)
    expect(env.text('GITHUB_APP_ENABLED')).toBe('1')
    expect(env.get('MINECRAFT_PAPER_BUILD')).toBe(130)
    expect(env.text('MINECRAFT_PAPER_BUILD')).toBe('130')
  })

  it('sees a change to the environment on the next read', () => {
    const vars: Record<string, string> = { ...REQUIRED }
    const env = makeEnv(
      () => vars,
      () => {},
    )
    expect(env.get('SITE_PATH')).toBe('/site')
    vars.SITE_PATH = '/tmp/site'
    expect(env.get('SITE_PATH')).toBe('/tmp/site')
  })
})
