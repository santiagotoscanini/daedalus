import { describe, expect, it } from 'vitest'
import { lokiQuote } from '../../host/loki'
import { activityLog, logVolume } from './metrics'

// A name reaches a LogQL selector quoted, never raw: a quote or a backslash in
// it must not end the label value early.

describe('the app pages’ Loki selectors', () => {
  const seen: string[] = []
  const ctx = {
    loki: {
      quote: lokiQuote,
      scalar: async (q: string) => {
        seen.push(q)
        return 0
      },
      streams: async (q: string) => {
        seen.push(q)
        return []
      },
    },
  } as never

  it('quotes the name in the log-volume and activity selectors', async () => {
    await logVolume(ctx, 'a"b\\c')
    await activityLog(ctx, 'a"b')
    expect(seen).toEqual([
      'sum(count_over_time({service_name="a\\"b\\\\c"}[1h]))',
      '{unit="app-a\\"b-deploy.service"}',
    ])
  })
})
