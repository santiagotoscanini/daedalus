import { describe, expect, it } from 'vitest'
import { ERROR_LINE, lineShape, NOISE, resetOffsets } from './log-noise'

// RE2 and JS regexes agree on everything used here except the inline flag.
const error = new RegExp(ERROR_LINE.replace('(?i)', ''), 'i')
const noise = new RegExp(NOISE.join('|'))
const counted = (line: string) => error.test(line) && !noise.test(line)

describe('what counts as an error', () => {
  it('counts the real ones', () => {
    for (const line of [
      '[ERR] [QueueCleaner] queue list failed: exception',
      'level=error msg="write operation failed"',
      'panic: failed to initialize',
      'Traceback (most recent call last):',
    ]) {
      expect(counted(line), line).toBe(true)
    }
  })

  it('does not count a line that only says the word', () => {
    for (const line of [
      'Monitored group=web-apps; endpoint=x; success=true; errors=0; duration=1ms',
      'INF HTTP request completed error_code=not_signed_in status=401',
      'Session termination failed: 202',
      '{"level":"error","message":"invalid api token format"}',
      'WARNING:  permission denied to vacuum "pg_authid", skipping it',
      '[argus] live probe miss http://203.0.113.1/x → body="Document Error: Not Found"',
      "http <-- 404, req: 'GET /-/npm/v1/attestations/x', error: resource not found",
    ]) {
      expect(counted(line), line).toBe(false)
    }
  })
})

describe('a line’s shape', () => {
  it('collapses repeats that differ only in time and ids', () => {
    const a = '2026-10-31T04:00:00Z [ERR] build 0123456789abcdef failed'
    const b = '2026-11-01T05:30:12Z [ERR] build fedcba9876543210 failed'
    expect(lineShape(a)).toBe(lineShape(b))
  })
})

describe('the nightly reset', () => {
  const at = (s: string) => new Date(`2026-10-31T${s}`)

  it('finds last night’s, ending the set minutes after the time', () => {
    expect(resetOffsets(at('10:00:00'), '04:00', 24, 6)).toEqual([(5 * 60 + 54) * 60])
  })

  it('leaves out a reset still to come', () => {
    expect(resetOffsets(at('03:00:00'), '04:00', 12, 6)).toEqual([])
  })

  it('finds one a day across a longer window', () => {
    expect(resetOffsets(at('10:00:00'), '04:00', 72, 6)).toHaveLength(3)
  })

  it('finds none without a time', () => {
    expect(resetOffsets(at('10:00:00'), '', 24, 6)).toEqual([])
    expect(resetOffsets(at('10:00:00'), 'never', 24, 6)).toEqual([])
  })
})
