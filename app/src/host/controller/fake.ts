import type { CallMethod, ControllerClient } from './client'
import type { Methods } from './generated'
import { ControllerError } from './wire'

// A controller for the tests: the live one is never asked anything there.

/** What a fake answers: a method's answer for its parameters. */
export type FakeAnswers = {
  [M in CallMethod]?: (p: Methods[M][0]) => Promise<Methods[M][1]> | Methods[M][1]
}

/**
 * A client that answers what a test gives it, fails every other method
 * `unreachable`, and records each method asked (`calls`) with its
 * parameters (`params`).
 */
export function fakeController(
  answers: FakeAnswers,
  over: Partial<Omit<ControllerClient, 'call'>> = {},
): ControllerClient & { calls: CallMethod[]; params: unknown[] } {
  const calls: CallMethod[] = []
  const params: unknown[] = []
  const call = (async (m: CallMethod, p?: unknown) => {
    calls.push(m)
    params.push(p ?? null)
    const answer = answers[m] as ((p: unknown) => unknown) | undefined
    if (answer === undefined) throw new ControllerError('unreachable', `fake: ${m}`)
    return answer(p ?? null)
  }) as ControllerClient['call']
  return {
    call,
    hello: () => null,
    link: () => ({ state: 'idle' }),
    close: () => undefined,
    ...over,
    calls,
    params,
  }
}
