import { describe, expect, it } from 'vitest'
import type { Ctx } from '../../../core/ctx'
import { type FakeAnswers, fakeController } from '../../../host/controller/fake'
import type { SystemInfo } from '../../../host/controller/generated'
import { ControllerError } from '../../../host/controller/wire'
import { loadController } from './controller'

const INFO = {
  api: 1,
  version: '0.13.0',
  mode: 'controller',
  uptime_secs: 42,
  telemetry: 'minimal',
  capabilities: ['claude.remote_control', 'telemetry.minimal'],
} as SystemInfo

const ctxWith = (answers: FakeAnswers) =>
  ({ controller: fakeController(answers) }) as unknown as Ctx

describe('the Host tab’s controller board', () => {
  it('reads the controller and its own Claude report', async () => {
    const d = await loadController(
      ctxWith({
        'system.info': () => INFO,
        'claude.status': () => ({ reporting: true, wanted: false, report: null }),
      }),
    )
    expect(d).toEqual({
      reachable: true,
      version: '0.13.0',
      mode: 'controller',
      api: 1,
      uptimeSecs: 42,
      telemetry: 'minimal',
      capabilities: ['claude.remote_control', 'telemetry.minimal'],
      claude: { wanted: false, reporting: true, state: null },
    })
  })

  it('asks nothing about Claude of a controller that does not offer it', async () => {
    const d = await loadController(
      ctxWith({
        'system.info': () => ({ ...INFO, capabilities: ['telemetry.minimal'] }),
        'claude.status': () => Promise.reject(new Error('must not be asked')),
      }),
    )
    expect(d.reachable && d.claude).toBeNull()
  })

  it('says why when the controller is not there', async () => {
    const d = await loadController(
      ctxWith({
        'system.info': () =>
          Promise.reject(
            new ControllerError(
              'unreachable',
              'no socket at /controller/api.sock; is daedalus-controller running?',
            ),
          ),
      }),
    )
    expect(d).toEqual({
      reachable: false,
      error: 'no socket at /controller/api.sock; is daedalus-controller running?',
    })
  })
})
